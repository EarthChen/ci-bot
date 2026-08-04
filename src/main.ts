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
import { logger } from "./util/log.js";
import { tmpdir } from "node:os";
import { join } from "node:path";

async function main(): Promise<void> {
  loadEnvFile(".env");
  const config = loadConfig();

  const app = Fastify({ logger: false });

  const workRoot = process.env.CIHEAL_WORK_ROOT ?? join(tmpdir(), "ci-self-heal-work");
  const workerManager = new SubprocessWorkerManager({
    timeoutMs: 5 * 60 * 1000,
  });
  const scheduler = new Scheduler({
    workerManager,
    workRoot,
    concurrency: config.concurrency,
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

main().catch((err) => {
  logger.error({ err }, "bot crashed");
  process.exit(1);
});
