/**
 * Shared path resolution — every writable data location derives from a single
 * `CIHEAL_DATA_ROOT`, so the operator configures one root instead of many.
 *
 * Layout under DATA_ROOT:
 *   work/   per-event worker cwd (temporary, removed after each run)
 *   bare/   shared git bare-clone cache (persistent, cleaned by retention)
 *   audit/  durable audit traces (persistent, cleaned by retention)
 *   logs/   main bot + worker logs (rotated by pino-roll)
 *   group-routing.db  dynamic webhook routes (SQLite, WAL; /route command)
 *
 * The hard "DATA_ROOT is required" guarantee lives in `loadConfig` (boot-time
 * validation), not here — validate at the boundary, be resilient inside. The
 * resolvers below fall back to a temp data root when `CIHEAL_DATA_ROOT` is
 * unset, so modules stay importable and the bot stays runnable in tests and
 * worker subprocesses where the env may not be present.
 *
 * Both the main process and worker subprocesses read `CIHEAL_DATA_ROOT` from
 * the environment (workers inherit it via the spawn env), so resolution here
 * is synchronous and side-effect-free.
 */

import { join } from "node:path";
import { tmpdir } from "node:os";

const DEFAULT_DATA_ROOT = join(tmpdir(), "ci-self-heal-data");

/** Resolve the data root; falls back to a temp dir when unset or blank. */
export function resolveDataRoot(): string {
	const root = process.env.CIHEAL_DATA_ROOT?.trim();
	return root ? root : DEFAULT_DATA_ROOT;
}

export function resolveWorkRoot(): string {
	return join(resolveDataRoot(), "work");
}

export function resolveBareRoot(): string {
	return join(resolveDataRoot(), "bare");
}

export function resolveAuditDir(): string {
	return join(resolveDataRoot(), "audit");
}

export function resolveLogDir(): string {
	return join(resolveDataRoot(), "logs");
}

/** SQLite file holding dynamic webhook routes (/route command). */
export function resolveRouteDbPath(): string {
	return join(resolveDataRoot(), "group-routing.db");
}
