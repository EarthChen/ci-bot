/**
 * End-to-end fixture test (ticket 07): aggregate metrics JSONL store.
 *
 * Each repair appends one JSONL line to metrics.jsonl in the worker cwd so
 * aggregate stats (success rate, avg repair time, cost/repair, repair count)
 * can be derived without an external metrics store. v1 uses a file (no
 * external dependency per G7); production ships lines to a metrics pipeline
 * (ticket 07 evolution seam → Prometheus + Grafana).
 *
 * The WHY:
 *  - A single repair's trace answers "what happened here?"; aggregate metrics
 *    answer "is the bot healthy overall?" — different question, different
 *    granularity. One-line-per-repair JSONL is cheap to append across a
 *    subprocess seam and trivial to aggregate with a reader script.
 *  - File-based keeps v1 dependency-free (no SQLite, no Prometheus);
 *    the JSONL schema is stable so swapping the sink later is a write-only
 *    change at the append point.
 */

import { describe, it, expect } from "vitest";
import Fastify, { type FastifyInstance } from "fastify";
import { mkdtemp, rm, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Scheduler } from "../../src/queue/scheduler.js";
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
	const res = await fetch(`${base}/webhook`, {
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

/** One metrics line. */
interface MetricLine {
	readonly projectId: string;
	readonly pipelineId: number;
	readonly outcome: string;
	readonly tokens: number;
	readonly cost: number;
	readonly durationMs: number;
	readonly createdAt: string;
}

/** Read the metrics.jsonl sidecar from the latest worker cwd under a root. */
async function readMetrics(root: string): Promise<MetricLine[] | null> {
	const { readdir } = await import("node:fs/promises");
	const entries = await readdir(root, { withFileTypes: true });
	const dirs = entries.filter((e) => e.isDirectory()).map((e) => e.name);
	for (const d of [...dirs].reverse()) {
		try {
			const raw = await readFile(join(root, d, "metrics.jsonl"), "utf8");
			return raw
				.split("\n")
				.filter((l) => l.trim() !== "")
				.map((l) => JSON.parse(l) as MetricLine);
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
	const workRoot = await mkdtemp(join(tmpdir(), "ciheal-metrics-"));
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
		concurrency: 1,
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

describe("aggregate metrics JSONL store (ticket 07)", () => {
	it("fixed → MR: appends one metrics.jsonl line with outcome + tokens + cost + duration", async () => {
		const bot = await setupBot({
			CIHEAL_STUB_FIX_KIND: "class2",
			CIHEAL_STUB_TURN_TOKENS: "8000",
		});
		try {
			const { status } = await postWebhook(
				bot.base,
				pipelineFailedBody("proj-met-mr", 900_100, "main", "a1a1a1a1a1a1a1a1"),
			);
			expect(status).toBe(202);
			await bot.scheduler.idle();

			const lines = await readMetrics(bot.workRoot);
			expect(lines).not.toBeNull();
			expect(lines!.length).toBe(1);

			const m = lines![0];
			expect(m.projectId).toBe("proj-met-mr");
			expect(m.pipelineId).toBe(900_100);
			expect(m.outcome).toBe("mr");
			expect(m.tokens).toBe(8000);
			expect(m.cost).toBeGreaterThan(0);
			expect(m.durationMs).toBeGreaterThanOrEqual(0);
			expect(m.createdAt).toBeTruthy();
		} finally {
			await bot.cleanup();
		}
	});

	it("escalated: appends a metrics line with outcome=escalated (escalations are counted)", async () => {
		const bot = await setupBot({ CIHEAL_STUB_FIX_KIND: "class4" });
		try {
			const { status } = await postWebhook(
				bot.base,
				pipelineFailedBody("proj-met-esc", 900_200, "main", "b2b2b2b2b2b2b2b2"),
			);
			expect(status).toBe(202);
			await bot.scheduler.idle();

			const lines = await readMetrics(bot.workRoot);
			expect(lines).not.toBeNull();
			expect(lines!.length).toBe(1);
			expect(lines![0].outcome).toBe("escalated");
			expect(lines![0].projectId).toBe("proj-met-esc");
		} finally {
			await bot.cleanup();
		}
	});

	it("class 5 early-filter: appends a metrics line with zero tokens (no agent ran)", async () => {
		const bot = await setupBot({ CIHEAL_STUB_CI_LOG: "class5" });
		try {
			const { status } = await postWebhook(
				bot.base,
				pipelineFailedBody("proj-met-c5", 900_300, "main", "c3c3c3c3c3c3c3c3"),
			);
			expect(status).toBe(202);
			await bot.scheduler.idle();

			const lines = await readMetrics(bot.workRoot);
			expect(lines).not.toBeNull();
			expect(lines!.length).toBe(1);
			expect(lines![0].outcome).toBe("escalated");
			expect(lines![0].tokens).toBe(0);
			expect(lines![0].cost).toBe(0);
		} finally {
			await bot.cleanup();
		}
	});
});
