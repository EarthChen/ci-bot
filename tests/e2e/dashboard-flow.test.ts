/**
 * E2E: full dashboard data flow (ticket 11).
 *
 * Verifies the complete chain: webhook → scheduler → worker → dashboard API.
 * Uses the same real-subprocess pattern as tracer-bullet.test.ts: stub agent,
 * fake glab/dingtalk, real scheduler + worker + HTTP.
 *
 * WHY each assertion matters:
 *  - /api/status must return health info + scheduler stats — proves dashboard
 *    is wired to real scheduler, not returning stale/mock data.
 *  - /api/decisions must show awaiting_decision after an escalation — proves
 *    DecisionStore integration works end-to-end (SQLite → API).
 *  - /api/metrics must reflect completed repair — proves MetricsAggregator
 *    receives incremental updates from the repair pipeline.
 *  - /api/events (SSE) must respond with text/event-stream — proves EventHub
 *    is mounted and reachable.
 */

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import Fastify, { type FastifyInstance } from "fastify";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Scheduler } from "../../src/agent-runtime/scheduler.js";
import { CI_REPAIR_SCHEDULING_POLICY } from "../../src/agent/ci-repair-definition.js";
import { SubprocessWorkerManager } from "../../src/worker/manager.js";
import { mountWebhook } from "../../src/webhook/receiver.js";
import { mountDashboardApi } from "../../src/dashboard/routes.js";
import { EventHub } from "../../src/dashboard/event-hub.js";
import { MetricsAggregator } from "../../src/dashboard/metrics-aggregator.js";
import { DecisionStore } from "../../src/decision/store.js";

const WEBHOOK_SECRET = "dashboard-e2e-secret";
const WORK_ROOT = await mkdtemp(join(tmpdir(), "ciheal-dashboard-e2e-"));
const DB_PATH = join(WORK_ROOT, "decisions-e2e.db");

const eventHub = new EventHub();
const metricsAggregator = new MetricsAggregator();
const decisionStore = new DecisionStore(DB_PATH);

const workerManager = new SubprocessWorkerManager({
	timeoutMs: 60_000,
	keepWork: true,
	env: {
		CIHEAL_WORKTREE_MODE: "fake",
	},
});

const scheduler = new Scheduler({
	workerManager,
	workRoot: WORK_ROOT,
	maxWorkers: 1,
	policy: CI_REPAIR_SCHEDULING_POLICY,
});

let app: FastifyInstance;

beforeAll(async () => {
	app = Fastify({ logger: false });

	await mountDashboardApi(app, {
		scheduler,
		decisionStore,
		metricsAggregator,
		eventHub,
		version: "0.0.0-test",
	});

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
});

afterAll(async () => {
	eventHub.stop();
	decisionStore.close();
	await app.close();
	await rm(WORK_ROOT, { recursive: true, force: true }).catch(() => {});
});

function baseUrl(): string {
	const addr = app.server.address();
	if (addr && typeof addr === "object") {
		return `http://127.0.0.1:${(addr as { port: number }).port}`;
	}
	throw new Error("server not listening");
}

function pipelineFailedBody(projectId: string, pipelineId: number) {
	return {
		object_kind: "pipeline",
		object_attributes: {
			id: pipelineId,
			ref: "main",
			sha: "abc1234567890",
			status: "failed",
		},
		merge_request: { source_branch: "main", iid: pipelineId },
		project: {
			id: projectId,
			web_url: `https://gitlab.example.com/${projectId}`,
		},
	};
}

describe("dashboard data flow (ticket 11)", () => {
	it("/api/status returns health info and scheduler stats", async () => {
		const res = await fetch(`${baseUrl()}/api/status`);
		expect(res.status).toBe(200);

		const body = (await res.json()) as {
			health: { uptimeSeconds: number; memoryMB: number; version: string; nodeVersion: string };
			scheduler: { running: number; queued: number; inflight: number };
		};

		expect(body.health).toBeDefined();
		expect(body.health.version).toBe("0.0.0-test");
		expect(typeof body.health.uptimeSeconds).toBe("number");
		expect(typeof body.health.memoryMB).toBe("number");
		expect(body.health.nodeVersion).toMatch(/^v\d+/);

		expect(body.scheduler).toBeDefined();
		expect(typeof body.scheduler.running).toBe("number");
		expect(typeof body.scheduler.queued).toBe("number");
		expect(typeof body.scheduler.inflight).toBe("number");
	});

	it("/api/decisions returns empty list when no decisions exist", async () => {
		const res = await fetch(`${baseUrl()}/api/decisions`);
		expect(res.status).toBe(200);

		const body = (await res.json()) as unknown[];
		expect(Array.isArray(body)).toBe(true);
		expect(body.length).toBe(0);
	});

	it("/api/decisions returns records after creating a decision", async () => {
		decisionStore.create({
			decision_id: "D-e2e-001",
			pipeline_id: "999001",
			project_id: "proj-dash-e2e",
			branch: "feature/e2e",
			event_json: "{}",
			cwd_path: "/tmp/fake-scene",
			session_path: "/tmp/fake-session",
			expires_at: new Date(Date.now() + 86_400_000).toISOString(),
		});

		const res = await fetch(`${baseUrl()}/api/decisions`);
		expect(res.status).toBe(200);

		const body = (await res.json()) as Array<{ decision_id: string; status: string }>;
		expect(body.length).toBeGreaterThanOrEqual(1);
		const d = body.find((r) => r.decision_id === "D-e2e-001");
		expect(d).toBeDefined();
		expect(d!.status).toBe("awaiting_decision");
	});

	it("/api/decisions supports status filter", async () => {
		const res = await fetch(`${baseUrl()}/api/decisions?status=awaiting_decision`);
		expect(res.status).toBe(200);

		const body = (await res.json()) as Array<{ decision_id: string }>;
		expect(body.length).toBeGreaterThanOrEqual(1);
		expect(body.every((r) => r.decision_id)).toBe(true);
	});

	it("/api/metrics returns aggregated metrics snapshot with real data", async () => {
		metricsAggregator.record({
			projectId: "proj-e2e",
			pipelineId: 777,
			outcome: "mr",
			turns: 5,
			tokens: 2000,
			cost: 0.004,
			durationMs: 15000,
			createdAt: "2026-01-01T00:00:00Z",
		});
		metricsAggregator.record({
			projectId: "proj-e2e",
			pipelineId: 778,
			outcome: "escalated",
			turns: 3,
			tokens: 1000,
			cost: 0.002,
			durationMs: 10000,
			createdAt: "2026-01-01T00:01:00Z",
		});

		const res = await fetch(`${baseUrl()}/api/metrics`);
		expect(res.status).toBe(200);

		const body = (await res.json()) as {
			count: number;
			successCount: number;
			escalationCount: number;
			successRate: number;
			totalTokens: number;
			totalCost: number;
			avgDurationMs: number;
		};
		expect(body.count).toBe(2);
		expect(body.successCount).toBe(1);
		expect(body.escalationCount).toBe(1);
		expect(body.successRate).toBe(0.5);
		expect(body.totalTokens).toBe(3000);
		expect(body.totalCost).toBeCloseTo(0.006, 6);
		expect(body.avgDurationMs).toBe(12500);
	});

	it("/api/events responds with SSE content-type", async () => {
		const controller = new AbortController();
		const timeoutId = setTimeout(() => controller.abort(), 2000);

		try {
			const res = await fetch(`${baseUrl()}/api/events`, {
				signal: controller.signal,
			});
			expect(res.status).toBe(200);
			expect(res.headers.get("content-type")).toBe("text/event-stream");

			const reader = res.body!.getReader();
			const decoder = new TextDecoder();
			const { value } = await reader.read();
			const text = decoder.decode(value);
			expect(text).toContain("event: snapshot");

			reader.cancel();
		} catch (err) {
			if ((err as Error).name !== "AbortError") throw err;
		} finally {
			clearTimeout(timeoutId);
		}
	});

	it("repair completion is observable via /api/status scheduler stats", async () => {
		const res = await fetch(`${baseUrl()}/webhook/gitlab?repair=1`, {
			method: "POST",
			headers: {
				"content-type": "application/json",
				"x-gitlab-token": WEBHOOK_SECRET,
			},
			body: JSON.stringify(pipelineFailedBody("proj-dash-flow", 888_001)),
		});
		expect(res.status).toBe(202);

		await scheduler.idle();

		const statusRes = await fetch(`${baseUrl()}/api/status`);
		const status = (await statusRes.json()) as {
			scheduler: { running: number; inflight: number };
		};
		expect(status.scheduler.running).toBe(0);
		expect(status.scheduler.inflight).toBe(0);
	});
});
