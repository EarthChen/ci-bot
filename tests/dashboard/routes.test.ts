import Fastify from "fastify";
import { describe, expect, it, vi } from "vitest";
import { mountDashboardApi, type DashboardDeps } from "../../src/dashboard/routes.js";
import type { DecisionRecord } from "../../src/decision/store.js";
import { MetricsAggregator } from "../../src/dashboard/metrics-aggregator.js";

function stubDeps(overrides?: Partial<DashboardDeps>): DashboardDeps {
	return {
		scheduler: {
			stats: () => ({ running: 1, queued: 2, inflight: 3, serialKeys: [] }),
			queueDetails: () => [],
		},
		decisionStore: {
			listByStatus: () => [],
			listAll: () => [],
		},
		version: "0.1.0-test",
		...overrides,
	};
}

function fakeDecision(overrides?: Partial<DecisionRecord>): DecisionRecord {
	return {
		decision_id: "D-100-abcd",
		pipeline_id: "100",
		project_id: "proj-1",
		event_json: '{"pipelineId":100}',
		cwd_path: "/tmp/secret-path",
		session_path: "/tmp/secret-session",
		branch: "ci-self-heal/main-abc12345",
		status: "awaiting_decision",
		created_at: "2026-08-19T10:00:00.000Z",
		expires_at: "2026-08-20T10:00:00.000Z",
		decided_by: null,
		decision_value: null,
		remark: null,
		oos_paths: null,
		decided_at: null,
		...overrides,
	};
}

describe("GET /api/status", () => {
	it("returns health + scheduler stats as JSON", async () => {
		const app = Fastify();
		await mountDashboardApi(app, stubDeps());

		const res = await app.inject({ method: "GET", url: "/api/status" });

		expect(res.statusCode).toBe(200);
		const body = res.json();
		expect(body.health).toMatchObject({
			version: "0.1.0-test",
		});
		expect(typeof body.health.uptimeSeconds).toBe("number");
		expect(typeof body.health.memoryMB).toBe("number");
		expect(body.scheduler).toEqual({ running: 1, queued: 2, inflight: 3, serialKeys: [] });
	});

	it("includes queue occupancy from scheduler.queueDetails()", async () => {
		const app = Fastify();
		await mountDashboardApi(app, stubDeps({
			scheduler: {
				stats: () => ({ running: 1, queued: 1, inflight: 2, serialKeys: ["proj-1:10", "proj-1:20"] }),
				queueDetails: () => [
					{ serialKey: "proj-1:10", pipelineId: 100, status: "running" },
					{ serialKey: "proj-1:20", pipelineId: 101, status: "queued" },
				],
			},
		}));

		const res = await app.inject({ method: "GET", url: "/api/status" });

		expect(res.statusCode).toBe(200);
		expect(res.json().queue).toEqual([
			{ serialKey: "proj-1:10", pipelineId: 100, status: "running" },
			{ serialKey: "proj-1:20", pipelineId: 101, status: "queued" },
		]);
	});
});

describe("dashboard API rate limiting", () => {
	it("returns 429 after exceeding 60 requests per minute per IP", async () => {
		const app = Fastify();
		await mountDashboardApi(app, stubDeps());

		for (let i = 0; i < 60; i++) {
			const res = await app.inject({ method: "GET", url: "/api/status" });
			expect(res.statusCode).toBe(200);
		}

		const blocked = await app.inject({ method: "GET", url: "/api/status" });
		expect(blocked.statusCode).toBe(429);
	});
});

describe("GET /api/decisions", () => {
	it("returns decision list with sensitive fields stripped", async () => {
		const app = Fastify();
		const decision = fakeDecision();
		await mountDashboardApi(app, stubDeps({
			decisionStore: {
				listByStatus: (status: string) =>
					status === "awaiting_decision" ? [decision] : [],
				listAll: () => [decision],
			},
		}));

		const res = await app.inject({ method: "GET", url: "/api/decisions" });

		expect(res.statusCode).toBe(200);
		const body = res.json();
		expect(body).toHaveLength(1);
		expect(body[0].decision_id).toBe("D-100-abcd");
		expect(body[0].project_id).toBe("proj-1");
		expect(body[0]).not.toHaveProperty("cwd_path");
		expect(body[0]).not.toHaveProperty("session_path");
		expect(body[0]).not.toHaveProperty("event_json");
	});

	it("filters by status query param", async () => {
		const listByStatus = vi.fn().mockReturnValue([fakeDecision()]);
		const app = Fastify();
		await mountDashboardApi(app, stubDeps({
			decisionStore: { listByStatus, listAll: () => [] },
		}));

		await app.inject({ method: "GET", url: "/api/decisions?status=awaiting_decision" });

		expect(listByStatus).toHaveBeenCalledWith("awaiting_decision");
	});

	it("returns all decisions when no status filter", async () => {
		const listAll = vi.fn().mockReturnValue([fakeDecision()]);
		const app = Fastify();
		await mountDashboardApi(app, stubDeps({
			decisionStore: { listByStatus: () => [], listAll },
		}));

		await app.inject({ method: "GET", url: "/api/decisions" });

		expect(listAll).toHaveBeenCalled();
	});
});

describe("GET /api/metrics", () => {
	it("returns snapshot plus recent repair entries", async () => {
		const agg = new MetricsAggregator();
		const repair = {
			projectId: "proj-1",
			pipelineId: 42,
			outcome: "mr",
			turns: 2,
			tokens: 500,
			cost: 0.002,
			durationMs: 45_000,
			createdAt: "2026-08-19T12:00:00.000Z",
		};
		agg.record(repair);

		const app = Fastify();
		await mountDashboardApi(app, stubDeps({ metricsAggregator: agg }));

		const res = await app.inject({ method: "GET", url: "/api/metrics" });

		expect(res.statusCode).toBe(200);
		const body = res.json();
		expect(body.count).toBe(1);
		expect(body.successCount).toBe(1);
		expect(body.recent).toHaveLength(1);
		expect(body.recent[0]).toEqual(repair);
	});

	it("returns at most 20 recent entries", async () => {
		const agg = new MetricsAggregator();
		for (let i = 0; i < 25; i++) {
			agg.record({
				projectId: "p1",
				pipelineId: i,
				outcome: "mr",
				turns: 1,
				tokens: 100,
				cost: 0.001,
				durationMs: 1000,
				createdAt: `2026-08-19T${String(i).padStart(2, "0")}:00:00.000Z`,
			});
		}

		const app = Fastify();
		await mountDashboardApi(app, stubDeps({ metricsAggregator: agg }));

		const res = await app.inject({ method: "GET", url: "/api/metrics" });

		expect(res.statusCode).toBe(200);
		expect(res.json().recent).toHaveLength(20);
	});
});

describe("GET /api/metrics/trend", () => {
	it("returns daily trend data from metrics aggregator", async () => {
		const today = new Date();
		today.setUTCHours(0, 0, 0, 0);
		const todayStr = today.toISOString().slice(0, 10);

		const agg = new MetricsAggregator();
		agg.record({
			projectId: "p1",
			pipelineId: 1,
			outcome: "mr",
			turns: 1,
			tokens: 100,
			cost: 0.001,
			durationMs: 1000,
			createdAt: `${todayStr}T10:00:00.000Z`,
		});

		const app = Fastify();
		await mountDashboardApi(app, stubDeps({ metricsAggregator: agg }));

		const res = await app.inject({ method: "GET", url: "/api/metrics/trend" });

		expect(res.statusCode).toBe(200);
		const body = res.json();
		expect(Array.isArray(body)).toBe(true);
		expect(body).toHaveLength(14);
		const todayEntry = body.find((d: { date: string }) => d.date === todayStr);
		expect(todayEntry).toEqual({ date: todayStr, success: 1, escalation: 0, failure: 0 });
	});
});
