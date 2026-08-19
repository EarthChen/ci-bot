/**
 * Bot entry point — wires config + webhook server + scheduler + worker manager.
 *
 * Production: `node dist/main.js`. Dev/tests: `tsx src/main.ts`.
 */

import { join, dirname } from "node:path";
import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import Fastify from "fastify";
import fastifyStatic from "@fastify/static";
import { DWClient } from "dingtalk-stream";
import { loadEnvFile, loadConfig } from "./config/index.js";
import { Scheduler, parseSkipStages } from "./agent-runtime/scheduler.js";
import { CI_REPAIR_SCHEDULING_POLICY } from "./agent/ci-repair-definition.js";
import { SubprocessWorkerManager } from "./worker/manager.js";
import { mountWebhook } from "./webhook/receiver.js";
import { removeMrSession } from "./pipeline/mr-session-store.js";
import { StreamDingTalkNotifier } from "./notify/stream-dingtalk.js";
import {
	type DingTalkMessage,
} from "./notify/dingtalk.js";
import {
	createPipelineFailureNotifier,
	type GroupMessageSender,
} from "./notify/pipeline-notification.js";
import { SidecarGroupSender } from "./notify/sidecar-sender.js";
import { createEscalationNotifier } from "./notify/escalation-notifier.js";
import { loadModelCandidates } from "./agent/model-selection.js";
import type { AgentModelRef } from "./types.js";
import { WebhookRouteStore } from "./notify/route-store.js";
import {
	buildUsageText,
	loadCommandHelp,
} from "./notify/command-help.js";
import { handleRouteCommand } from "./notify/route-command.js";
import { handleHelpCommand } from "./notify/help-command.js";
import { handleHealCommand } from "./decision/heal-command.js";
import { createDecisionLifecycle } from "./decision/lifecycle.js";
import { loadGroupRouting, ProjectRouter } from "./notify/project-router.js";
import { DingTalkStreamBot } from "./notify/stream-bot.js";
import { logger } from "./util/log.js";
import { resolveAuditDir, resolveDecisionDbPath, resolveLogDir, resolveRouteDbPath, resolveWorkRoot } from "./config/paths.js";
import { DecisionStore } from "./decision/store.js";
import { mountDashboardApi, sanitizeDecision } from "./dashboard/routes.js";
import { EventHub } from "./dashboard/event-hub.js";
import { MetricsAggregator } from "./dashboard/metrics-aggregator.js";
import { dispatchIpcMessage } from "./dashboard/ipc-dispatch.js";
import { isWorkerIpcMessage } from "./dashboard/ipc-types.js";

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
			? new SidecarGroupSender(join(resolveLogDir(), "dingtalk-fake.jsonl"))
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
	// 终局通知的引用源：webhook 即时播报正文按 pipelineId 留存主进程内存。
	const broadcastMemory = new Map<number, string>();

	// 播报「修复模型」：候选链首位 = 计划模型（实际选择以运行时报备为准，
	// 终局通知上报真实选中项）。
	let plannedModel: AgentModelRef | undefined;
	try {
		const candidates = loadModelCandidates(
			join(config.botRoot, "config", "model-candidates.json"),
		);
		const first = candidates[0];
		if (first) {
			plannedModel = {
				provider: first.provider,
				model: first.model,
				thinkingLevel: first.defaultThinkingLevel,
			};
		}
	} catch (err) {
		logger.warn(
			{ err },
			"model candidates unreadable — broadcast will omit repair model",
		);
	}

	const pipelineNotifier = createPipelineFailureNotifier({
		router: projectRouter,
		sender: groupSender,
		...(plannedModel ? { plannedModel } : {}),
		recordBroadcast: (pipelineId, text) => {
			if (broadcastMemory.size >= 256) {
				const oldest = broadcastMemory.keys().next().value;
				if (oldest !== undefined) broadcastMemory.delete(oldest);
			}
			broadcastMemory.set(pipelineId, text);
		},
	});

	// Routed escalation notification (T04): all escalated notifications are
	// sent from the main process through the project router (same group as
	// the webhook failure broadcast).
	const escalationNotifier = createEscalationNotifier({
		router: projectRouter,
		sender: groupSender,
		originalBroadcast: (pipelineId) => broadcastMemory.get(pipelineId),
	});

	// Decision lifecycle (T07): a newly accepted pipeline invalidates the
	// project's stale awaiting decisions (store + scene cleanup + notify).
	const decisionLifecycle = createDecisionLifecycle({
		store: decisionStore,
		router: projectRouter,
		sender: groupSender,
	});

	// TTL sweep (T08): expired awaiting decisions are swept, their scenes
	// cleaned and the routed groups notified. Interval defaults to 60s
	// (CIHEAL_DECISION_SWEEP_INTERVAL_MS overrides).
	const ttlSweep = decisionLifecycle.startTtlSweep();

	// Command help text (externalized to config/command-help.json; a missing
	// file is a deploy error — the loader throws at boot).
	const commandHelp = loadCommandHelp(
		join(config.botRoot, "config", "command-help.json"),
	);
	const routeUsageText = buildUsageText(commandHelp, "/route");
	const healUsageText = buildUsageText(commandHelp, "/heal");

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
						usageText: healUsageText,
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
	// Dashboard: EventHub (SSE broadcast) + MetricsAggregator (audit preload).
	const eventHub = new EventHub();
	const metricsAggregator = new MetricsAggregator();
	try {
		await metricsAggregator.load(resolveAuditDir());
	} catch (err) {
		logger.warn({ err }, "metrics preload failed — dashboard starts with empty metrics");
	}

	decisionStore.setOnChange((action, record) => {
		eventHub.emit({
			type: action === "create" ? "decision_created" : "decision_resolved",
			data: sanitizeDecision(record),
		});
	});

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
		onIpcMessage: (event, msg) => {
			if (!isWorkerIpcMessage(msg)) return;
			dispatchIpcMessage(
				{
					eventHub,
					metricsAggregator,
					workerId: `${event.projectId}-${event.pipelineId}`,
				},
				msg,
			);
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
		skipStages: parseSkipStages(process.env.CIHEAL_SKIP_STAGES),
		onLifecycleEvent: (type, data) => eventHub.emit({ type, data }),
	});

	// Dashboard: serve the React SPA from dist/dashboard/ (built by Vite).
	const __mainDirname = dirname(fileURLToPath(import.meta.url));
	const dashboardDir = join(__mainDirname, "dashboard");
	if (existsSync(dashboardDir)) {
		await app.register(fastifyStatic, {
			root: dashboardDir,
			prefix: "/dashboard/",
			decorateReply: false,
		});
		// SPA fallback: React Router client-side routing needs index.html for
		// any unmatched /dashboard/* path on page refresh.
		app.get("/dashboard/*", (_req, reply) => {
			void reply.sendFile("index.html", dashboardDir);
		});
	}

	// Populate initial SSE snapshot so new clients get real data on connect.
	eventHub.updateSnapshot({
		health: {
			uptimeSeconds: Math.floor(process.uptime()),
			memoryMB: Math.round(process.memoryUsage().rss / 1_048_576),
			version: process.env.npm_package_version ?? "0.0.0",
		},
		scheduler: scheduler.stats(),
		metrics: metricsAggregator.snapshot(),
	});

	// Dashboard API: /api/status, /api/decisions, /api/metrics, /api/events (SSE).
	await mountDashboardApi(app, {
		scheduler,
		decisionStore,
		metricsAggregator,
		eventHub,
		version: process.env.npm_package_version ?? "0.0.0",
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
		onNewPipeline: (event) => decisionLifecycle.onNewPipeline(event),
		// MR 终局（merge/close）：作废该 MR 的待决策+清现场，删 session 存档。
		onMrTerminal: async (mrEvent) => {
			await decisionLifecycle.onMrTerminal(mrEvent);
			removeMrSession(mrEvent.projectId, mrEvent.mrIid);
		},
	});

	await app.listen({ port: config.port, host: "0.0.0.0" });
	logger.info({ port: config.port }, "ci-self-heal bot listening");

	const shutdown = async () => {
		ttlSweep.stop();
		eventHub.stop();
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
