/**
 * End-to-end fixture test (ticket 07): per-fix trace metrics.
 *
 * Extends the G5 audit sidecar with observability fields: turns / tokens /
 * cost / durationMs. These let a single repair be audited post-hoc for cost
 * and time (ticket 07 scope), complementing ticket 06's safety fields
 * (diff + diagnosis + reasoning).
 *
 * The WHY:
 *  - tokens + cost per repair feed the monthly cost-estimate formula
 *    (N × daily-repairs × tokens × unit-price × 30). Without per-fix token
 *    capture, the formula has no real input.
 *  - durationMs catches slow repairs (e.g. agent stuck in a tool-call loop)
 *    that would otherwise inflate average-repair-time metrics silently.
 *  - turns catches runaway sessions before they hit the budget soft limit.
 */

import { describe, it, expect } from "vitest";
import Fastify, { type FastifyInstance } from "fastify";
import { mkdtemp, rm, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Scheduler } from "../../src/agent-runtime/scheduler.js";
import { CI_REPAIR_SCHEDULING_POLICY } from "../../src/agent/ci-repair-definition.js";
import { SubprocessWorkerManager } from "../../src/worker/manager.js";
import { mountWebhook } from "../../src/webhook/receiver.js";

const WEBHOOK_SECRET = "test-secret-token";

function pipelineFailedBody(
	projectId: string,
	pipelineId: number,
	ref = "main",
	sha = "abc1234567890",
): unknown {
	return {
		object_kind: "pipeline",
		object_attributes: { id: pipelineId, ref, sha, status: "failed" },
		merge_request: { source_branch: ref, iid: pipelineId },
		project: {
			id: projectId,
			web_url: `https://gitlab.example.com/${projectId}`,
		},
	};
}

async function postWebhook(
	base: string,
	body: unknown,
	token = WEBHOOK_SECRET,
): Promise<{ status: number; json: unknown }> {
	const res = await fetch(`${base}/webhook/gitlab?repair=1`, {
		method: "POST",
		headers: { "content-type": "application/json", "x-gitlab-token": token },
		body: JSON.stringify(body),
	});
	const text = await res.text();
	let json: unknown = null;
	try {
		json = JSON.parse(text);
	} catch {
		json = text;
	}
	return { status: res.status, json };
}

/** The extended audit-trace shape (ticket 06 safety fields + ticket 07 metrics). */
interface AuditTrace {
	readonly event: {
		readonly projectId: string;
		readonly pipelineId: number;
		readonly ref: string;
		readonly sha: string;
	};
	readonly outcome: string;
	readonly diagnosis: {
		readonly failureClass: number;
		readonly summary: string;
	};
	readonly diff: string;
	readonly reasoning: string;
	readonly mrUrl?: string;
	readonly createdAt: string;
	/** Ticket 07: per-fix observability metrics. */
	readonly turns: number;
	readonly tokens: number;
	readonly cost: number;
	readonly durationMs: number;
}

async function readSidecar<T>(root: string, name: string): Promise<T | null> {
	const { readdir } = await import("node:fs/promises");
	const entries = await readdir(root, { withFileTypes: true });
	const dirs = entries.filter((e) => e.isDirectory()).map((e) => e.name);
	for (const d of [...dirs].reverse()) {
		try {
			const raw = await readFile(join(root, d, name), "utf8");
			return JSON.parse(raw) as T;
		} catch {
			void 0;
		}
	}
	return null;
}

async function setupBot(env: Record<string, string>): Promise<{
	app: FastifyInstance;
	scheduler: Scheduler;
	base: string;
	workRoot: string;
	cleanup: () => Promise<void>;
}> {
	const workRoot = await mkdtemp(join(tmpdir(), "ciheal-trace-"));
	const workerManager = new SubprocessWorkerManager({
		timeoutMs: 60_000,
		keepWork: true,
		env: {
			CIHEAL_AGENT_MODE: "real",
			CIHEAL_SESSION_FACTORY: "stub",
			CIHEAL_WORKTREE_MODE: "fake",
			...env,
		},
	});
	const scheduler = new Scheduler({
		workerManager,
		workRoot,
		maxWorkers: 1,
		policy: CI_REPAIR_SCHEDULING_POLICY,
	});
	const app = Fastify({ logger: false });
	await mountWebhook(app, {
		scheduler,
		config: {
			webhookSecret: WEBHOOK_SECRET,
			ipAllowlist: [],
			rateLimitMax: 1000,
			rateLimitWindowMs: 60_000,
		},
	});
	await app.listen({ port: 0, host: "127.0.0.1" });
	const addr = app.server.address();
	const base = `http://127.0.0.1:${(addr as { port: number }).port}`;
	return {
		app,
		scheduler,
		base,
		workRoot,
		cleanup: async () => {
			await app.close();
			await rm(workRoot, { recursive: true, force: true }).catch(() => {});
		},
	};
}

describe("per-fix trace metrics (ticket 07)", () => {
	it("fixed → MR: audit-trace.json records turns + tokens + cost + durationMs", async () => {
		const bot = await setupBot({
			CIHEAL_STUB_FIX_KIND: "class2",
			// Stub session reports this many tokens per turn (1 turn).
			CIHEAL_STUB_TURN_TOKENS: "8000",
		});
		try {
			const { status } = await postWebhook(
				bot.base,
				pipelineFailedBody("proj-tr-mr", 800_100, "main", "f1e2d3c4b5a69788"),
			);
			expect(status).toBe(202);
			await bot.scheduler.idle();

			const audit = await readSidecar<AuditTrace>(
				bot.workRoot,
				"audit-trace.json",
			);
			expect(audit).not.toBeNull();

			// Turns recorded (stub session = 1 turn).
			expect(audit!.turns).toBe(1);

			// Tokens recorded (matches CIHEAL_STUB_TURN_TOKENS — feeds the
			// monthly cost-estimate formula with real per-fix input).
			expect(audit!.tokens).toBe(8000);

			// Cost derived from tokens × unit price (non-zero, finite).
			expect(audit!.cost).toBeGreaterThan(0);
			expect(Number.isFinite(audit!.cost)).toBe(true);

			// Duration recorded (the repair took some measurable wall time).
			expect(audit!.durationMs).toBeGreaterThanOrEqual(0);

			// Ticket 06 safety fields still present (no regression).
			expect(audit!.outcome).toBe("mr");
			expect(audit!.diagnosis.failureClass).toBe(2);
			expect(audit!.mrUrl).toBeTruthy();
		} finally {
			await bot.cleanup();
		}
	});

	it("escalated: audit-trace.json still records turns + tokens (escalations cost budget too)", async () => {
		const bot = await setupBot({
			CIHEAL_STUB_FIX_KIND: "class3-no-spec",
			CIHEAL_STUB_TURN_TOKENS: "4000",
		});
		try {
			const { status } = await postWebhook(
				bot.base,
				pipelineFailedBody("proj-tr-esc", 800_200, "main", "e2d3c4b5a6978800"),
			);
			expect(status).toBe(202);
			await bot.scheduler.idle();

			const audit = await readSidecar<AuditTrace>(
				bot.workRoot,
				"audit-trace.json",
			);
			expect(audit).not.toBeNull();
			expect(audit!.outcome).toBe("escalated");
			// Escalations still consumed tokens (the agent ran before escalating).
			expect(audit!.tokens).toBe(4000);
			expect(audit!.turns).toBe(1);
			expect(audit!.cost).toBeGreaterThan(0);
		} finally {
			await bot.cleanup();
		}
	});

	it("class 5 early-filter: audit-trace.json records zero turns/tokens (no agent ran)", async () => {
		// The class-5 path skips the agent entirely — tokens/turns must be 0,
		// not absent (a trace must explain "why did this cost nothing").
		const bot = await setupBot({ CIHEAL_STUB_CI_LOG: "class5" });
		try {
			const { status } = await postWebhook(
				bot.base,
				pipelineFailedBody("proj-tr-c5", 800_300, "main", "d3c4b5a697880011"),
			);
			expect(status).toBe(202);
			await bot.scheduler.idle();

			const audit = await readSidecar<AuditTrace>(
				bot.workRoot,
				"audit-trace.json",
			);
			expect(audit).not.toBeNull();
			expect(audit!.outcome).toBe("escalated");
			expect(audit!.turns).toBe(0);
			expect(audit!.tokens).toBe(0);
			expect(audit!.cost).toBe(0);
		} finally {
			await bot.cleanup();
		}
	});
});
