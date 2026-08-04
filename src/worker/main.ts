/**
 * Worker subprocess entry point (run by the worker manager via tsx/node).
 *
 * Reads CIHEAL_WORKER_TASK, runs the G2 pipeline for one event, writes the
 * RepairOutcome to CIHEAL_RESULT_FILE, and prints it to stdout.
 */

import { main } from "./entry.js";
import { logger } from "../util/log.js";

main().catch((err) => {
  // Fail loud: a worker crash must surface, not be swallowed.
  logger.error({ err }, "worker main failed");
  process.exit(1);
});
