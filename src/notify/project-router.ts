/**
 * Project → DingTalk-group routing.
 *
 * Ported from code-review-bot's `ProjectRouter` (src/webhook/routing.py),
 * full five-tier resolution order:
 *   dynamic exact → dynamic wildcard → static exact → static wildcard → default.
 * The static layer comes from `config/group-routing.json`; the dynamic layer
 * is a live source (backed by WebhookRouteStore / SQLite in production),
 * written by the /route group command.
 */

import { readFileSync } from "node:fs";

/** Static routing table: project path (or glob) → openConversationId. */
export interface GroupRoutingConfig {
	readonly routes: Readonly<Record<string, string>>;
	readonly defaultConversationId: string;
}

/**
 * Live source of the dynamic route layer. Called on every resolve() —
 * cheap (a single SQLite SELECT over a handful of rows) — so routes written
 * out-of-band take effect without restarting the bot.
 */
export type DynamicRouteSource = () => Readonly<Record<string, string>>;

export class ProjectRouter {
	private readonly staticExact: Map<string, string>;
	private readonly staticPatterns: ReadonlyArray<{
		readonly regex: RegExp;
		readonly conversationId: string;
	}>;

	constructor(
		routes: Readonly<Record<string, string>>,
		private readonly defaultConversationId: string,
		private readonly dynamic: DynamicRouteSource = () => ({}),
	) {
		const { exact, patterns } = splitRoutes(routes);
		this.staticExact = exact;
		this.staticPatterns = patterns;
	}

	/**
	 * Resolve a project path to a group conversation id, or null.
	 * Order (code-review-bot parity): dynamic exact → dynamic wildcard →
	 * static exact → static wildcard → default.
	 */
	resolve(projectPath: string): string | null {
		const { exact: dynExact, patterns: dynPatterns } = splitRoutes(
			this.dynamic(),
		);

		const dynamicHit = dynExact.get(projectPath);
		if (dynamicHit) return dynamicHit;
		for (const { regex, conversationId } of dynPatterns) {
			if (regex.test(projectPath)) return conversationId;
		}

		const staticHit = this.staticExact.get(projectPath);
		if (staticHit) return staticHit;
		for (const { regex, conversationId } of this.staticPatterns) {
			if (regex.test(projectPath)) return conversationId;
		}

		return this.defaultConversationId || null;
	}
}

function splitRoutes(routes: Readonly<Record<string, string>>): {
	exact: Map<string, string>;
	patterns: Array<{ regex: RegExp; conversationId: string }>;
} {
	const exact = new Map<string, string>();
	const patterns: Array<{ regex: RegExp; conversationId: string }> = [];
	for (const [pattern, conversationId] of Object.entries(routes)) {
		if (pattern.includes("*") || pattern.includes("?")) {
			patterns.push({ regex: globToRegExp(pattern), conversationId });
		} else {
			exact.set(pattern, conversationId);
		}
	}
	return { exact, patterns };
}

/**
 * Load `config/group-routing.json`. A missing file means "no static routes"
 * (routing still works via the default conversation id); a malformed file
 * throws — bad config must fail loud, not silently misroute.
 */
export function loadGroupRouting(path: string): GroupRoutingConfig {
	let raw: string;
	try {
		raw = readFileSync(path, "utf8");
	} catch {
		return { routes: {}, defaultConversationId: "" };
	}
	const parsed: unknown = JSON.parse(raw);
	if (typeof parsed !== "object" || parsed === null) {
		throw new Error(`group routing config must be an object: ${path}`);
	}
	const obj = parsed as Record<string, unknown>;

	const routes: Record<string, string> = {};
	const rawRoutes = obj.routes ?? {};
	if (typeof rawRoutes !== "object" || rawRoutes === null) {
		throw new Error(`group routing "routes" must be an object: ${path}`);
	}
	for (const [pattern, conversationId] of Object.entries(
		rawRoutes as Record<string, unknown>,
	)) {
		if (typeof conversationId !== "string") {
			throw new Error(
				`group routing routes["${pattern}"] must be a string conversation id: ${path}`,
			);
		}
		routes[pattern] = conversationId;
	}

	const defaultConversationId =
		typeof obj.defaultConversationId === "string"
			? obj.defaultConversationId
			: "";
	return { routes, defaultConversationId };
}

/** Glob (`*`/`?`) → anchored RegExp; other regex specials are escaped. */
function globToRegExp(pattern: string): RegExp {
	const escaped = pattern
		.replace(/[.+^${}()|[\]\\]/g, "\\$&")
		.replace(/\*/g, ".*")
		.replace(/\?/g, ".");
	return new RegExp(`^${escaped}$`);
}
