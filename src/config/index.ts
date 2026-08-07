/**
 * Configuration loader.
 *
 * Loads secrets/runtime config from process.env (populated by a .env file).
 * The bot never persists secrets; it reads them into a typed config object.
 *
 * Per G5: `.env` MUST be chmod 600 + gitignored + never committed.
 * This module validates presence of required keys at startup (fail fast).
 */

import { readFileSync } from "node:fs";
import { isAbsolute } from "node:path";

export interface BotConfig {
	/** GitLab webhook secret token (verified against X-Gitlab-Token header). */
	readonly gitlabWebhookSecret: string;
	/** GitLab access token for glab CLI (read_repository + api scope). */
	readonly gitlabToken: string;
	/** GitLab base URL (self-hosted). Empty = gitlab.com default. */
	readonly gitlabUrl: string;
	/** DingTalk Stream bot clientId (AppKey). */
	readonly dingtalkClientId: string;
	/** DingTalk Stream bot clientSecret (AppSecret). */
	readonly dingtalkClientSecret: string;
	/** DingTalk default group conversation ID for notifications. */
	readonly dingtalkConversationId: string;
	/** Global worker concurrency cap. Ticket 01 hardcodes effective N=1. */
	readonly concurrency: number;
	/** Comma-separated GitLab egress IP/CIDR allowlist. Empty = skip. */
	readonly ipAllowlist: readonly string[];
	/** Webhook server port. */
	readonly port: number;
	/** Node env. */
	readonly nodeEnv: string;
	/** Absolute bot release root containing bot-owned Pi resources. */
	readonly botRoot: string;
	/** Absolute deployment-owned directory containing Pi auth/models configuration. */
	readonly piBaseDir: string;
	/** Absolute writable data root (work/bare/audit/logs derive from it). */
	readonly dataRoot: string;
}

/**
 * Parse a `.env` file body into key/value pairs.
 *
 * Minimal but correct: handles `KEY=value`, `KEY="quoted"`, `KEY='quoted'`,
 * comments (`# ...`), blank lines, and `export KEY=value` prefixes.
 * Does NOT support multi-line values or escape interpolation — secrets are
 * opaque blobs, not shell scripts.
 */
export function parseEnvFile(body: string): Record<string, string> {
	const out: Record<string, string> = {};
	for (const rawLine of body.split(/\r?\n/)) {
		const line = rawLine.trim();
		if (line === "" || line.startsWith("#")) continue;
		const stripped = line.startsWith("export ") ? line.slice(7) : line;
		const eq = stripped.indexOf("=");
		if (eq < 0) continue;
		const key = stripped.slice(0, eq).trim();
		let value = stripped.slice(eq + 1).trim();
		// Strip matching surrounding quotes.
		if (
			(value.startsWith('"') && value.endsWith('"')) ||
			(value.startsWith("'") && value.endsWith("'"))
		) {
			value = value.slice(1, -1);
		}
		out[key] = value;
	}
	return out;
}

/** Load a .env file from disk and merge into process.env (without clobbering real env). */
export function loadEnvFile(path: string): Record<string, string> {
	try {
		const body = readFileSync(path, "utf8");
		const parsed = parseEnvFile(body);
		for (const [k, v] of Object.entries(parsed)) {
			// Real process.env always wins over .env file.
			if (process.env[k] === undefined) process.env[k] = v;
		}
		return parsed;
	} catch {
		// .env missing is fine in test/dev; required keys still validated below.
		return {};
	}
}

function required(key: string): string {
	const value = process.env[key];
	if (!value || value.trim() === "") {
		throw new Error(
			`Missing required config: ${key}. Set it in .env (chmod 600, gitignored) or the real environment.`,
		);
	}
	return value.trim();
}

function optional(key: string, fallback = ""): string {
	const value = process.env[key];
	return value && value.trim() !== "" ? value.trim() : fallback;
}

function requiredAbsolutePath(key: string): string {
	const value = required(key);
	if (!isAbsolute(value)) throw new Error(`${key} must be an absolute path`);
	return value;
}

/** Build a typed BotConfig from process.env. Throws on missing required secrets. */
export function loadConfig(): BotConfig {
	const concurrencyRaw = optional("BOT_CONCURRENCY", "1");
	const concurrency = Math.max(1, Math.floor(Number(concurrencyRaw) || 1));
	const portRaw = optional("PORT", "8080");
	const port = Math.floor(Number(portRaw) || 8080);
	const ipAllowlist = optional("GITLAB_IP_ALLOWLIST")
		.split(",")
		.map((s) => s.trim())
		.filter((s) => s !== "");

	return {
		gitlabWebhookSecret: required("GITLAB_WEBHOOK_SECRET"),
		gitlabToken: required("GITLAB_TOKEN"),
		gitlabUrl: optional("GITLAB_URL", "https://gitlab.com"),
		dingtalkClientId: required("DINGTALK_CLIENT_ID"),
		dingtalkClientSecret: required("DINGTALK_CLIENT_SECRET"),
		dingtalkConversationId: optional("DINGTALK_CONVERSATION_ID"),
		concurrency,
		ipAllowlist,
		port,
		nodeEnv: optional("NODE_ENV", "development"),
		botRoot: requiredAbsolutePath("CIHEAL_BOT_ROOT"),
		piBaseDir: requiredAbsolutePath("CIHEAL_PI_BASE_DIR"),
		dataRoot: requiredAbsolutePath("CIHEAL_DATA_ROOT"),
	};
}
