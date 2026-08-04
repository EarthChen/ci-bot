/**
 * GitLab pipeline webhook receiver.
 *
 * Per G7/G2: the endpoint validates X-Gitlab-Token, applies an IP allowlist +
 * rate limit, dedupes by pipeline id, and enqueues onto the scheduler.
 *
 * The route is mounted onto a Fastify instance (the app composes it; tests
 * own the server lifecycle on an ephemeral port).
 */

import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import type { Scheduler } from "../queue/scheduler.js";
import type { PipelineEvent } from "../types.js";
import { logger } from "../util/log.js";

export interface WebhookConfig {
	/** Expected X-Gitlab-Token value (secret shared with GitLab). */
	readonly webhookSecret: string;
	/** GitLab egress IP/CIDR allowlist. Empty = skip allowlist check. */
	readonly ipAllowlist: readonly string[];
	/** Max webhook requests per windowMs per IP. */
	readonly rateLimitMax: number;
	readonly rateLimitWindowMs: number;
}

interface RateBucket {
	count: number;
	windowStart: number;
}

/** Parse a GitLab pipeline webhook payload into a PipelineEvent. */
export function parsePipelinePayload(body: unknown): PipelineEvent | null {
	if (typeof body !== "object" || body === null) return null;
	const obj = body as Record<string, unknown>;
	if (obj.object_kind !== "pipeline") return null;
	const attrs = (obj.object_attributes ?? {}) as Record<string, unknown>;
	// Only act on failed pipelines (success/running/pending ignored).
	if (attrs.status !== "failed") return null;
	const projectId = extractProjectId(
		(obj.project ?? {}) as Record<string, unknown>,
	);
	if (projectId === null) return null;
	const ref = attrs.ref;
	const sha = attrs.sha;
	if (
		typeof attrs.id !== "number" ||
		typeof ref !== "string" ||
		typeof sha !== "string"
	) {
		return null;
	}
	return {
		projectId,
		pipelineId: attrs.id,
		ref,
		sha,
		projectUrl: extractProjectUrl(
			(obj.project ?? {}) as Record<string, unknown>,
		),
	};
}

function extractProjectId(project: Record<string, unknown>): string | null {
	const id = project.id;
	if (typeof id !== "number" && typeof id !== "string") return null;
	const value = String(id);
	return /^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(value) ? value : null;
}

function extractProjectUrl(project: Record<string, unknown>): string {
	if (typeof project.web_url === "string") return project.web_url;
	if (typeof project.url === "string") return project.url;
	return "";
}

export interface MountWebhookDeps {
	readonly scheduler: Scheduler;
	readonly config: WebhookConfig;
}

/** Rate-limit state (in-memory; ticket 07 may move to SQLite-backed). */
const rateBuckets = new Map<string, RateBucket>();

export async function mountWebhook(
	app: FastifyInstance,
	deps: MountWebhookDeps,
): Promise<void> {
	// Fastify route registration is synchronous; the Promise return type keeps
	// the seam forward-compatible with future async setup (e.g. plugin hooks).
	app.post("/webhook", async (req: FastifyRequest, reply: FastifyReply) => {
		// 1. IP allowlist (empty = skip; dev convenience).
		if (deps.config.ipAllowlist.length > 0) {
			const ip = req.ip;
			if (!ipAllowed(ip, deps.config.ipAllowlist)) {
				logger.warn({ ip }, "webhook ip rejected");
				return reply.code(403).send({ error: "forbidden" });
			}
		}

		// 2. Rate limit (per-IP token bucket).
		if (
			!rateAllowed(
				req.ip,
				deps.config.rateLimitMax,
				deps.config.rateLimitWindowMs,
			)
		) {
			logger.warn({ ip: req.ip }, "webhook rate limited");
			return reply.code(429).send({ error: "rate_limited" });
		}

		// 3. Signature (X-Gitlab-Token shared secret).
		const token = req.headers["x-gitlab-token"];
		if (token !== deps.config.webhookSecret) {
			logger.warn({ ip: req.ip }, "webhook token invalid");
			return reply.code(401).send({ error: "unauthorized" });
		}

		// 4. Parse + filter to failed pipelines.
		const event = parsePipelinePayload(req.body);
		if (event === null) {
			// Not a pipeline-failed event — acknowledge but do nothing.
			return reply.code(202).send({ status: "ignored" });
		}

		// 5. Enqueue (idempotent by pipeline id).
		const status = deps.scheduler.enqueue(event);
		if (status === "duplicate") {
			return reply.code(202).send({ status: "duplicate" });
		}
		return reply.code(202).send({ status: "queued" });
	});
}

function ipAllowed(ip: string, allowlist: readonly string[]): boolean {
	// v1: exact IP match (CIDR matching is a ticket-05 refinement).
	return allowlist.includes(ip);
}

function rateAllowed(ip: string, max: number, windowMs: number): boolean {
	const now = Date.now();
	const bucket = rateBuckets.get(ip);
	if (!bucket || now - bucket.windowStart > windowMs) {
		rateBuckets.set(ip, { count: 1, windowStart: now });
		return true;
	}
	bucket.count += 1;
	return bucket.count <= max;
}
