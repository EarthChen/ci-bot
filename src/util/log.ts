/**
 * Structured JSON logger (pino).
 *
 * Per G7: every bot operation logs as structured JSON — webhook receive,
 * queue, spawn, agent run, verification, MR, notification. The e2e test
 * doesn't assert on log lines (that couples to implementation); logs are for
 * human operators + downstream metrics (ticket 07).
 */

import pino from "pino";

export const logger = pino.pino({
  level: process.env.LOG_LEVEL ?? "info",
  base: undefined, // drop default pid/hostname noise from dev logs
});
