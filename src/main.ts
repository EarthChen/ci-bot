/**
 * Bot entry point — wires config + webhook server + scheduler + worker manager.
 *
 * Production: `node dist/main.js`. Dev/tests: `tsx src/main.ts`.
 */

import Fastify from "fastify";
import { DWClient } from "dingtalk-stream";
import { loadEnvFile, loadConfig } from "./config/index.js";
import { Scheduler } from "./queue/scheduler.js";
import { SubprocessWorkerManager } from "./worker/manager.js";
import { mountWebhook } from "./webhook/receiver.js";
import { StreamDingTalkNotifier } from "./notify/stream-dingtalk.js";
import { DingTalkStreamBot } from "./notify/stream-bot.js";
import { logger } from "./util/log.js";
import { tmpdir } from "node:os";
import { join } from "node:path";

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

	// Stream bot: WebSocket receiver in main process (long-lived).
	const streamBot = new DingTalkStreamBot({
		client: dingtalkClient,
		onMessage: async (message) => {
			// First version: log only. Command handlers can be registered here.
			logger.info(
				{ text: message.text, sender: message.senderNick },
				"dingtalk message received (no handler registered)",
			);
		},
	});
	await streamBot.start();

	// Notifier: sends push messages via SDK API (groupMessages/send).
	const notifier = new StreamDingTalkNotifier({
		client: dingtalkClient,
		robotCode: config.dingtalkClientId,
		conversationId: config.dingtalkConversationId,
	});

	const workRoot =
		process.env.CIHEAL_WORK_ROOT ?? join(tmpdir(), "ci-self-heal-work");
	const workerManager = new SubprocessWorkerManager({
		timeoutMs: 5 * 60 * 1000,
		env: {
			// Production: real agent (pi SDK) + real glab + real dingtalk.
			CIHEAL_AGENT_MODE: "real",
			CIHEAL_GLAB_MODE: "real",
			CIHEAL_DINGTALK_MODE: "real",
			CIHEAL_BOT_ROOT: config.botRoot,
			CIHEAL_PI_BASE_DIR: config.piBaseDir,
			// Worker subprocesses use SDK API push (no WebSocket needed).
			DINGTALK_CLIENT_ID: config.dingtalkClientId,
			DINGTALK_CLIENT_SECRET: config.dingtalkClientSecret,
			DINGTALK_CONVERSATION_ID: config.dingtalkConversationId,
		},
	});
	const scheduler = new Scheduler({
		workerManager,
		workRoot,
		concurrency: config.concurrency,
		notifier,
		workerCrashThreshold: Number(process.env.BOT_WORKER_CRASH_THRESHOLD ?? "3"),
	});

	await mountWebhook(app, {
		scheduler,
		config: {
			webhookSecret: config.gitlabWebhookSecret,
			ipAllowlist: config.ipAllowlist,
			rateLimitMax: 30,
			rateLimitWindowMs: 60_000,
		},
	});

	await app.listen({ port: config.port, host: "0.0.0.0" });
	logger.info({ port: config.port }, "ci-self-heal bot listening");

	const shutdown = async () => {
		streamBot.stop();
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
