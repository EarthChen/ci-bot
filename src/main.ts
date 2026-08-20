/**
 * Bot entry point — wires config + webhook server + scheduler + worker manager.
 *
 * Production: `node dist/main.js`. Dev/tests: `tsx src/main.ts`.
 */

import { join, dirname } from "node:path";
import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import Fastify from "fastify";
import { DWClient } from "dingtalk-stream";
import { loadEnvFile, loadConfig } from "./config/index.js";
import { Scheduler, parseSkipStages } from "./agent-runtime/scheduler.js";
import { CI_REPAIR_SCHEDULING_POLICY } from "./agent/ci-repair-definition.js";
import { SubprocessWorkerManager } from "./worker/manager.js";
import { mountWebhook } from "./webhook/receiver.js";
import { removeMrSession, saveMrSession } from "./pipeline/mr-session-store.js";
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
import { mountDashboardApi, mountDashboardStatic, sanitizeDecision } from "./dashboard/routes.js";
import { EventHub } from "./dashboard/event-hub.js";
import { MetricsAggregator } from "./dashboard/metrics-aggregator.js";
import { dispatchIpcMessage } from "./dashboard/ipc-dispatch.js";
import { isWorkerIpcMessage } from "./dashboard/ipc-types.js";
import { GlabGitLabClient } from "./gitlab/glab-client.js";

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
		saveMrSession,
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

	const mainGlab = new GlabGitLabClient(async (args) => {
		const { execFile } = await import("node:child_process");
		const { promisify } = await import("node:util");
		const execFileP = promisify(execFile);
		const { stdout } = await execFileP("glab", args as string[], {
			env: { ...process.env, GITLAB_HOST: process.env.GITLAB_URL ?? "" },
			maxBuffer: 128 * 1024 * 1024,
		});
		return stdout;
	});

	let scheduler!: Scheduler;
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
			if (msg.type === "steer_delivered") {
				scheduler.onSteerDelivered(CI_REPAIR_SCHEDULING_POLICY.serialKey(event));
			}
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
	scheduler = new Scheduler({
		workerManager,
		workRoot,
		policy: CI_REPAIR_SCHEDULING_POLICY,
		maxWorkers: config.concurrency,
		notifier,
		workerCrashThreshold: Number(process.env.BOT_WORKER_CRASH_THRESHOLD ?? "3"),
		decisionStore,
		escalationNotifier,
		skipStages: parseSkipStages(process.env.CIHEAL_SKIP_STAGES),
		coalescenceNotifier: async (superseded, superseding) => {
			const conversationId = projectRouter.resolve(superseded.projectId);
			if (!conversationId) {
				logger.warn(
					{ projectId: superseded.projectId, pipelineId: superseded.pipelineId },
					"coalescence notification skipped: no group route",
				);
				return;
			}
			await groupSender.sendTo(conversationId, {
				title: "CI 自愈排队合并",
				text: `项目 ${superseded.projectId} pipeline ${superseded.pipelineId}（sha ${superseded.sha.slice(0, 8)}）已被新 pipeline ${superseding.pipelineId}（sha ${superseding.sha.slice(0, 8)}）取代，跳过修复。`,
			});
		},
		greenChecker: async (event) => {
			if (event.mrIid == null) return false;
			try {
				const status = await mainGlab.fetchMrPipelineStatus(
					event.projectId,
					event.mrIid,
				);
				return status.status === "success";
			} catch (err) {
				logger.warn(
					{ err, event: { projectId: event.projectId, mrIid: event.mrIid } },
					"green check failed",
				);
				return false;
			}
		},
		greenSkipNotifier: async (event) => {
			const conversationId = projectRouter.resolve(event.projectId);
			if (!conversationId) {
				logger.warn(
					{ projectId: event.projectId, pipelineId: event.pipelineId },
					"green skip notification skipped: no group route",
				);
				return;
			}
			await groupSender.sendTo(conversationId, {
				title: "CI 自愈绿灯跳过",
				text: `项目 ${event.projectId} pipeline ${event.pipelineId}（MR !${event.mrIid}）最新 CI 已通过，跳过修复。`,
			});
		},
		supersedeProvider: {
			async getChangedFiles(_running, incoming) {
				if (!incoming.mrIid) return undefined;
				try {
					const diff = await mainGlab.fetchMrDiff(
						incoming.projectId,
						incoming.mrIid,
					);
					if (!diff) return undefined;
					const files = [
						...new Set(
							diff
								.split("\n")
								.filter((l) => l.startsWith("diff --git"))
								.map((l) => {
									const match = l.match(/b\/(.+)$/);
									return match?.[1];
								})
								.filter((f): f is string => !!f),
						),
					];
					return files.length > 0 ? files : undefined;
				} catch {
					return undefined;
				}
			},
		},
		onLifecycleEvent: (type, data) => {
			// worker 注册表 + snapshot 刷新：SSE 事件 fire-and-forget，迟到客户端
			// 只能看 snapshot，故每个生命周期节点都把权威状态推进 snapshot。
			if (type === "worker_started" && typeof data.workerId === "string") {
				eventHub.workerStarted(data.workerId, {
					pipelineId: Number(data.pipelineId),
					projectId: String(data.projectId),
					cwd: typeof data.cwd === "string" ? data.cwd : undefined,
				});
			} else if (type === "worker_done" && typeof data.workerId === "string") {
				eventHub.workerDone(data.workerId);
			}
			eventHub.updateSnapshot({
				health: {
					uptimeSeconds: Math.floor(process.uptime()),
					memoryMB: Math.round(process.memoryUsage().rss / 1_048_576),
					version: process.env.npm_package_version ?? "0.0.0",
				},
				scheduler: scheduler.stats(),
			});
			eventHub.emit({ type, data });
		},
	});

	// Dashboard: serve the React SPA from dist/dashboard-web/ (built by Vite;
	// dist/dashboard 被 tsc 的 src/dashboard 后端模块占用，见 vite.config）。
	const __mainDirname = dirname(fileURLToPath(import.meta.url));
	const dashboardDir = join(__mainDirname, "dashboard-web");
	if (existsSync(dashboardDir)) {
		await mountDashboardStatic(app, dashboardDir);
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
		workers: [],
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
		// Stop intake first so no new events enqueue during the drain.
		await app.close();
		// Kill active workers + await their scene cleanup; a restart must not
		// leave worktree residue blocking the next pipeline of the same MR.
		await workerManager.shutdown();
		routeStore.close();
		decisionStore.close();
		process.exit(0);
	};
	process.on("SIGTERM", shutdown);
	process.on("SIGINT", shutdown);
}

main().catch((err) => {
	logger.error({ err }, "bot crashed");
	process.exit(1);
});
