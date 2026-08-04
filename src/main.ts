/**
 * Bot entry point — wires config + webhook server + scheduler + worker manager.
 *
 * Production: `node dist/main.js`. Dev/tests: `tsx src/main.ts`.
 */

import Fastify from "fastify";
import { loadEnvFile, loadConfig } from "./config/index.js";
import { Scheduler } from "./queue/scheduler.js";
import { SubprocessWorkerManager } from "./worker/manager.js";
import { mountWebhook } from "./webhook/receiver.js";
import { HttpDingTalkNotifier } from "./notify/dingtalk.js";
import { logger } from "./util/log.js";
import { tmpdir } from "node:os";
import { join } from "node:path";

async function main(): Promise<void> {
	loadEnvFile(".env");
	const config = loadConfig();

	const app = Fastify({ logger: false });

	const workRoot =
		process.env.CIHEAL_WORK_ROOT ?? join(tmpdir(), "ci-self-heal-work");
	const workerManager = new SubprocessWorkerManager({
		timeoutMs: 5 * 60 * 1000,
		env: {
			// Production: real agent (pi SDK) + real glab + real dingtalk.
			CIHEAL_AGENT_MODE: "real",
			CIHEAL_GLAB_MODE: "real",
			CIHEAL_DINGTALK_MODE: "real",
		},
	});
	const scheduler = new Scheduler({
		workerManager,
		workRoot,
		concurrency: config.concurrency,
		// Ticket 07: self-fault DingTalk alert on repeated worker crashes.
		notifier: new HttpDingTalkNotifier(config.dingtalkWebhookUrl, httpPost),
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
		await app.close();
		process.exit(0);
	};
	process.on("SIGTERM", shutdown);
	process.on("SIGINT", shutdown);
}

/** HTTP POST used by the DingTalk notifier (fetch wrapper). */
async function httpPost(url: string, body: unknown): Promise<void> {
	const res = await fetch(url, {
		method: "POST",
		headers: { "content-type": "application/json" },
		body: JSON.stringify(body),
	});
	if (!res.ok) {
		throw new Error(`dingtalk webhook failed: ${res.status} ${res.statusText}`);
	}
}

main().catch((err) => {
	logger.error({ err }, "bot crashed");
	process.exit(1);
});
