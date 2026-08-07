/**
 * Retention policy loader.
 *
 * Loads disk-retention thresholds from the bot-owned, non-sensitive
 * `config/retention-policy.json` (same directory pattern as
 * model-candidates.json). The policy shapes three cleanup concerns:
 *
 *   - bare:  git bare-clone cache — max age (mTime) + max entry count (LRU)
 *   - audit: durable audit-trace dir — max age (mTime)
 *   - logs:  pino-roll rotation — max size + keep count
 *
 * Loaded lazily and cached; a missing file falls back to built-in defaults
 * (so a fresh checkout still gets sane retention), while a malformed file
 * throws so misconfiguration is caught loudly at first use.
 */

import { readFileSync } from "node:fs";
import { existsSync } from "node:fs";
import { join } from "node:path";

export interface BareRetention {
	/** Delete a bare clone whose last write is older than this many days. */
	readonly maxAgeDays: number;
	/** When the bare dir exceeds this many entries, evict oldest (LRU). */
	readonly maxEntries: number;
}

export interface AuditRetention {
	/** Delete an audit bucket whose last write is older than this many days. */
	readonly maxAgeDays: number;
}

export interface LogsRetention {
	/** pino-roll `size` trigger (e.g. "10MB"); rotates when exceeded. */
	readonly maxSize: string;
	/** Number of rotated log files to retain. */
	readonly keep: number;
}

export interface RetentionPolicy {
	readonly bare: BareRetention;
	readonly audit: AuditRetention;
	readonly logs: LogsRetention;
}

const DEFAULTS: RetentionPolicy = {
	bare: { maxAgeDays: 30, maxEntries: 100 },
	audit: { maxAgeDays: 90 },
	logs: { maxSize: "10MB", keep: 5 },
};

let cached: RetentionPolicy | null = null;

/** Resolve the bot-owned config dir (mirrors model-selection's pattern but
 * honors CIHEAL_BOT_ROOT when set so workers share the same policy). */
function configDir(): string {
	const botRoot = process.env.CIHEAL_BOT_ROOT;
	if (botRoot) return join(botRoot, "config");
	return join(process.cwd(), "config");
}

/** Load the retention policy, falling back to defaults when the file is absent. */
export function resolveRetentionPolicy(): RetentionPolicy {
	if (cached) return cached;
	const path = join(configDir(), "retention-policy.json");
	if (!existsSync(path)) {
		cached = DEFAULTS;
		return cached;
	}
	let parsed: unknown;
	try {
		parsed = JSON.parse(readFileSync(path, "utf8")) as unknown;
	} catch (err) {
		throw new Error(
			`malformed retention policy at ${path}: ${
				err instanceof Error ? err.message : String(err)
			}`,
		);
	}
	cached = normalize(parsed, path);
	return cached;
}

/** Validate + fill missing fields with defaults (deep-ish merge). */
function normalize(raw: unknown, path: string): RetentionPolicy {
	if (typeof raw !== "object" || raw === null) {
		throw new Error(`malformed retention policy at ${path}: expected object`);
	}
	const r = raw as Record<string, unknown>;
	const bare = (r.bare ?? {}) as Record<string, unknown>;
	const audit = (r.audit ?? {}) as Record<string, unknown>;
	const logs = (r.logs ?? {}) as Record<string, unknown>;
	const num = (v: unknown, key: string, fallback: number): number => {
		if (v === undefined) return fallback;
		const n = Number(v);
		if (!Number.isFinite(n) || n < 0) {
			throw new Error(`malformed retention policy at ${path}: ${key} must be a non-negative number`);
		}
		return n;
	};
	return {
		bare: {
			maxAgeDays: num(bare.maxAgeDays, "bare.maxAgeDays", DEFAULTS.bare.maxAgeDays),
			maxEntries: num(bare.maxEntries, "bare.maxEntries", DEFAULTS.bare.maxEntries),
		},
		audit: {
			maxAgeDays: num(audit.maxAgeDays, "audit.maxAgeDays", DEFAULTS.audit.maxAgeDays),
		},
		logs: {
			maxSize:
				typeof logs.maxSize === "string" && logs.maxSize !== ""
					? logs.maxSize
					: DEFAULTS.logs.maxSize,
			keep: num(logs.keep, "logs.keep", DEFAULTS.logs.keep),
		},
	};
}

/** Test hook: clear the cached policy so a test can re-read on next call. */
export function resetRetentionPolicyCache(): void {
	cached = null;
}