/**
 * Bot entry point — wires config + webhook server + scheduler + worker manager.
 *
 * Production: `node dist/main.js`. Dev/tests: `tsx src/main.ts`.
 */

import { join } from "node:path";
import Fastify from "fastify";
import { DWClient } from "dingtalk-stream";
import { loadEnvFile, loadConfig } from "./config/index.js";
import { Scheduler } from "./agent-runtime/scheduler.js";
import { CI_REPAIR_SCHEDULING_POLICY } from "./agent/ci-repair-definition.js";
import { SubprocessWorkerManager } from "./worker/manager.js";
import { mountWebhook } from "./webhook/receiver.js";
import { StreamDingTalkNotifier } from "./notify/stream-dingtalk.js";
import {
	InMemoryDingTalkNotifier,
	type DingTalkMessage,
} from "./notify/dingtalk.js";
import {
	createPipelineFailureNotifier,
	type GroupMessageSender,
} from "./notify/pipeline-notification.js";
import { createEscalationNotifier } from "./notify/escalation-notifier.js";
import { WebhookRouteStore } from "./notify/route-store.js";
import {
	buildUsageText,
	loadCommandHelp,
} from "./notify/command-help.js";
import { handleRouteCommand } from "./notify/route-command.js";
import { handleHelpCommand } from "./notify/help-command.js";
import { handleHealCommand } from "./decision/heal-command.js";
import { loadGroupRouting, ProjectRouter } from "./notify/project-router.js";
import { DingTalkStreamBot } from "./notify/stream-bot.js";
import { logger } from "./util/log.js";
import { resolveDecisionDbPath, resolveRouteDbPath, resolveWorkRoot } from "./config/paths.js";
import { DecisionStore } from "./decision/store.js";

async function main(): Promise<void> {
	loadEnvFile(".env");
	const config = loadConfig();

	const app = Fastify({ logger: false });

	// DingTalk Stream client — shared by bot (receiver) and notifier (sender).
	const dingtalkClient = new DWClient({
		clientId: config.dingtalkClientId,
		clientSecret: config.dingtalkClientSecret,
		debug: config.nodeEnv === "development",
	});

	// Notifier: sends push messages via SDK API (groupMessages/send).
	const notifier = new StreamDingTalkNotifier({
		client: dingtalkClient,
		robotCode: config.dingtalkClientId,
		conversationId: config.dingtalkConversationId,
	});

	// Fake DingTalk mode records instead of pushing (no real traffic in dev).
	const groupSender: GroupMessageSender =
		process.env.CIHEAL_DINGTALK_MODE === "fake"
			? new InMemoryDingTalkNotifier()
			: notifier;

	// Dynamic route store (SQLite under DATA_ROOT): the /route command writes,
	// the router's dynamic layer reads live on every resolve.
	const routeStore = new WebhookRouteStore(resolveRouteDbPath());

	// Decision store (SQLite under DATA_ROOT): the scheduler registers
	// awaiting_decision records for decidable escalations (scene retention).
	const decisionStore = new DecisionStore(resolveDecisionDbPath());

	// Routed CI-failure group notification (ported from code-review-bot):
	// dynamic exact → dynamic wildcard → static exact → static wildcard → default.
	const routing = loadGroupRouting(
		join(config.botRoot, "config", "group-routing.json"),
	);
	const projectRouter = new ProjectRouter(
		routing.routes,
		routing.defaultConversationId || config.dingtalkConversationId,
		() => routeStore.getMapping(),
	);
	const pipelineNotifier = createPipelineFailureNotifier({
		router: projectRouter,
		sender: groupSender,
	});

	// Routed escalation notification (T04): all escalated notifications are
	// sent from the main process through the project router (same group as
	// the webhook failure broadcast).
	const escalationNotifier = createEscalationNotifier({
		router: projectRouter,
		sender: groupSender,
	});

	// Command help text (externalized to config/command-help.json; a missing
	// file is a deploy error — the loader throws at boot).
	const commandHelp = loadCommandHelp(
		join(config.botRoot, "config", "command-help.json"),
	);
	const routeUsageText = buildUsageText(commandHelp, "/route");

	// Stream bot: WebSocket receiver in main process (long-lived).
	// Group commands: /route (dynamic group routing), /help (externalized help).
	const streamBot = new DingTalkStreamBot({
		client: dingtalkClient,
		onMessage: async (message) => {
			const reply = (conversationId: string, msg: DingTalkMessage) =>
				groupSender.sendTo(conversationId, msg);
			try {
				if (
					await handleRouteCommand(
						{ store: routeStore, reply, usageText: routeUsageText },
						message,
					)
				)
					return;
				if (await handleHelpCommand({ help: commandHelp, reply }, message))
					return;
				if (
					await handleHealCommand(
						{
							store: decisionStore,
							reply,
							enqueueResume: (record) => scheduler.enqueueResume(record),
						},
						message,
					)
				)
					return;
			} catch (err) {
				logger.warn({ err, text: message.text }, "dingtalk command failed");
				return;
			}
			logger.info(
				{ text: message.text, sender: message.senderNick },
				"dingtalk message received (no command matched)",
			);
		},
	});
	// 本地/异常网络下 DingTalk Stream WS 可能连不上；容错避免主进程崩溃。
	try {
		await streamBot.start();
	} catch (err) {
		logger.warn({ err }, "dingtalk stream bot 启动失败，继续运行（仅缺失 WS 接收）");
	}
	// Per-event worker cwd root — derived from CIHEAL_DATA_ROOT (work/).
	const workRoot = resolveWorkRoot();
	const workerManager = new SubprocessWorkerManager({
		timeoutMs: Number(process.env.BOT_WORKER_TIMEOUT_MS ?? 300_000) || 300_000,
		env: {
			// 生产默认 real；本地测试可用同名环境变量覆盖（如 CIHEAL_DINGTALK_MODE=fake）。
			CIHEAL_AGENT_MODE: process.env.CIHEAL_AGENT_MODE ?? "real",
			CIHEAL_GLAB_MODE: process.env.CIHEAL_GLAB_MODE ?? "real",
			CIHEAL_DINGTALK_MODE: process.env.CIHEAL_DINGTALK_MODE ?? "real",
			CIHEAL_BOT_ROOT: config.botRoot,
			CIHEAL_PI_BASE_DIR: config.piBaseDir,
			CIHEAL_DATA_ROOT: config.dataRoot,
			// Worker subprocesses use SDK API push (no WebSocket needed).
			DINGTALK_CLIENT_ID: config.dingtalkClientId,
			DINGTALK_CLIENT_SECRET: config.dingtalkClientSecret,
			DINGTALK_CONVERSATION_ID: config.dingtalkConversationId,
		},
	});
	const scheduler = new Scheduler({
		workerManager,
		workRoot,
		policy: CI_REPAIR_SCHEDULING_POLICY,
		maxWorkers: config.concurrency,
		notifier,
		workerCrashThreshold: Number(process.env.BOT_WORKER_CRASH_THRESHOLD ?? "3"),
		decisionStore,
		escalationNotifier,
	});

	await mountWebhook(app, {
		scheduler,
		config: {
			webhookSecret: config.gitlabWebhookSecret,
			ipAllowlist: config.ipAllowlist,
			rateLimitMax: 30,
			rateLimitWindowMs: 60_000,
		},
		pipelineNotifier,
	});

	await app.listen({ port: config.port, host: "0.0.0.0" });
	logger.info({ port: config.port }, "ci-self-heal bot listening");

	const shutdown = async () => {
		streamBot.stop();
		routeStore.close();
		decisionStore.close();
		await app.close();
		process.exit(0);
	};
	process.on("SIGTERM", shutdown);
	process.on("SIGINT", shutdown);
}

main().catch((err) => {
	logger.error({ err }, "bot crashed");
	process.exit(1);
});
