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
import type { Scheduler } from "../agent-runtime/scheduler.js";
import type { PipelineFailureNotifier } from "../notify/pipeline-notification.js";
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
	// MR-triggered pipelines carry a `merge_request` object with the real
	// source_branch (ref is the synthetic `refs/merge-requests/<iid>/head`,
	// not a mergeable target). Extract so the fix MR targets the MR's source
	// branch — merging the fix updates the source MR's CI.
	// v1: bot only handles MR-triggered pipelines; push/trigger pipelines
	// lack merge_request → reject here.
	const mr = (obj.merge_request ?? {}) as Record<string, unknown>;
	if (typeof mr.source_branch !== "string") return null;
	const mrSourceBranch = mr.source_branch;
	const mrIid = typeof mr.iid === "number" ? mr.iid : undefined;
	return {
		projectId,
		pipelineId: attrs.id,
		ref,
		sha,
		projectUrl: extractProjectUrl(
			(obj.project ?? {}) as Record<string, unknown>,
		),
		...(mrSourceBranch ? { mrSourceBranch } : {}),
		...(mrIid ? { mrIid } : {}),
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
	/** Immediate CI-failure group notification (optional; ported from code-review-bot). */
	readonly pipelineNotifier?: PipelineFailureNotifier;
	/** Fired after a NEW pipeline event is accepted (enqueued) — e.g. decision
	 *  invalidation (T07). Errors are caught and logged: the enqueue already
	 *  happened, so the webhook response must never be affected. */
	readonly onPipelineAccepted?: (event: PipelineEvent) => Promise<void>;
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

		// 5. Repair opt-in gate: only `repair=1|true` in the webhook URL query
		//    triggers the auto-repair; other events take the notify-only path
		//    (CI-failure group broadcast, code-review-bot parity).
		if (!isRepairRequested(req.query)) {
			await notifyQuietly(deps, req.body, event.pipelineId);
			return reply.code(202).send({ status: "notify-only" });
		}

		// 6. Enqueue (idempotent by pipeline id).
		const status = deps.scheduler.enqueue(event);
		if (status === "duplicate") {
			return reply.code(202).send({ status: "duplicate" });
		}
		// 6b. Lifecycle hook (T07): a NEW accepted pipeline invalidates the
		//     project's stale awaiting decisions. Failures are caught — the
		//     enqueue already happened; the response must not be affected.
		if (deps.onPipelineAccepted) {
			try {
				await deps.onPipelineAccepted(event);
			} catch (err) {
				logger.warn(
					{ err, pipelineId: event.pipelineId },
					"onPipelineAccepted hook failed",
				);
			}
		}
		// 7. Immediate group notification (ported from code-review-bot's
		//    PipelineHandler). Decoupled from enqueue: a notification failure
		//    must never affect the already-queued repair.
		await notifyQuietly(deps, req.body, event.pipelineId);
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

/** Repair opt-in switch: `repair=1|true` (case-insensitive) in the webhook
 *  URL query triggers the auto-repair; anything else (absent/0/false) skips
 *  it. GitLab webhook URLs are configured per project, so opting a project in
 *  is just appending `?repair=1` to its webhook URL. */
export function isRepairRequested(query: unknown): boolean {
	if (typeof query !== "object" || query === null) return false;
	const raw = (query as Record<string, unknown>).repair;
	const value = Array.isArray(raw) ? raw[0] : raw;
	if (typeof value !== "string") return false;
	const normalized = value.toLowerCase();
	return normalized === "1" || normalized === "true";
}

/** Immediate group notification; failures only warn, never affect the flow. */
async function notifyQuietly(
	deps: MountWebhookDeps,
	rawPayload: unknown,
	pipelineId: number,
): Promise<void> {
	if (!deps.pipelineNotifier) return;
	try {
		await deps.pipelineNotifier.notify(rawPayload);
	} catch (err) {
		logger.warn({ err, pipelineId }, "pipeline failure notification failed");
	}
}
