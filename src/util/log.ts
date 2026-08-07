/**
 * Structured JSON logger (pino).
 *
 * Per G7: every bot operation logs as structured JSON — webhook receive,
 * queue, spawn, agent run, verification, MR, notification. The e2e test
 * doesn't assert on log lines (that couples to implementation); logs are for
 * human operators + downstream metrics (ticket 07).
 */

import pino from "pino";
import { mkdirSync } from "node:fs";
import { join as joinPath } from "node:path";
import { resolveLogDir } from "../config/paths.js";
import { resolveRetentionPolicy } from "../config/retention.js";

const isWorker = Boolean(process.env.CIHEAL_WORKER_TASK);

/**
 * Convert a human size string (e.g. "10MB", "10KB") to pino-roll's
 * single-char unit format ("10m", "10k"). pino-roll's parser only accepts
 * one trailing unit char, so "10MB" would throw.
 */
function toPinoRollSize(maxSize: string): string {
	const m = maxSize.trim().match(/^([\d.]+)\s*([KMG])?B?$/i);
	if (!m) return maxSize;
	const unit = (m[2] ?? "M").toLowerCase();
	return `${m[1]}${unit}`;
}

const targets: Array<{ target: string; options: Record<string, unknown>; level: string }> = [
	{ target: "pino/file", options: { destination: 1 }, level: "info" },
];

if (isWorker) {
	// Workers log to a per-event file in the audit directory so that
	// worker output is durable and easy to trace (survives per-event cwd
	// cleanup). The directory is set via CIHEAL_WORKER_LOG_DIR by the
	// worker manager; without it, workers fall back to stdout only.
	const workerLogDir = process.env.CIHEAL_WORKER_LOG_DIR;
	if (workerLogDir) {
		try {
			mkdirSync(workerLogDir, { recursive: true });
		} catch {
			// ignore — fall back to stdout only
		}
		targets.push({
			target: "pino/file",
			options: { destination: joinPath(workerLogDir, "worker.log"), mkdir: true },
			level: "info",
		});
	}
} else {
	const logDir = resolveLogDir();
	try {
		mkdirSync(logDir, { recursive: true });
	} catch {
		// ignore — fall back to stdout only
	}
	// Rotate bot.log by size, retaining the most recent N copies (passive,
	// no timer). Thresholds come from config/retention-policy.json.
	const { maxSize, keep } = resolveRetentionPolicy().logs;
	try {
		targets.push({
			target: "pino-roll",
			options: {
				file: joinPath(logDir, "bot.log"),
				size: toPinoRollSize(maxSize),
				limit: { count: keep },
				mkdir: true,
			},
			level: "info",
		});
	} catch {
		// retention policy unreadable — fall back to a plain file target.
		targets.push({
			target: "pino/file",
			options: { destination: joinPath(logDir, "bot.log"), mkdir: true },
			level: "info",
		});
	}
}

export const logger = pino.pino({
	level: process.env.LOG_LEVEL ?? "info",
	base: undefined, // drop default pid/hostname noise from dev logs
	transport: { targets },
});
