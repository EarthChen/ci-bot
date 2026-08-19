import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { MetricsAggregator, type MetricsEntry } from "../../src/dashboard/metrics-aggregator.js";

let auditDir: string;

beforeEach(async () => {
	auditDir = await mkdtemp(join(tmpdir(), "metrics-test-"));
});

afterEach(async () => {
	await rm(auditDir, { recursive: true, force: true });
});

function entry(outcome: string, tokens = 1000, cost = 0.001, durationMs = 60_000, createdAt = "2026-08-19T10:00:00.000Z"): MetricsEntry {
	return { projectId: "p1", pipelineId: 1, outcome, turns: 3, tokens, cost, durationMs, createdAt };
}

async function writeMetrics(pipelineDir: string, entries: MetricsEntry[]): Promise<void> {
	const dir = join(auditDir, pipelineDir);
	await mkdir(dir, { recursive: true });
	const lines = entries.map((e) => JSON.stringify(e)).join("\n") + "\n";
	await writeFile(join(dir, "metrics.jsonl"), lines);
}

describe("MetricsAggregator", () => {
	it("loads metrics from audit directory on startup", async () => {
		await writeMetrics("100", [entry("mr", 2000, 0.002, 30_000)]);
		await writeMetrics("101", [entry("escalated", 3000, 0.003, 90_000)]);

		const agg = new MetricsAggregator();
		await agg.load(auditDir);
		const snap = agg.snapshot();

		expect(snap.count).toBe(2);
		expect(snap.successCount).toBe(1);
		expect(snap.escalationCount).toBe(1);
		expect(snap.failureCount).toBe(0);
		expect(snap.totalTokens).toBe(5000);
		expect(snap.totalCost).toBeCloseTo(0.005);
		expect(snap.avgDurationMs).toBe(60_000);
	});

	it("records incremental entries", async () => {
		const agg = new MetricsAggregator();
		await agg.load(auditDir);

		agg.record(entry("mr", 1000, 0.001, 50_000));
		agg.record(entry("failed", 500, 0.0005, 20_000));

		const snap = agg.snapshot();
		expect(snap.count).toBe(2);
		expect(snap.successCount).toBe(1);
		expect(snap.failureCount).toBe(1);
	});

	it("returns zeros on empty audit directory", async () => {
		const agg = new MetricsAggregator();
		await agg.load(auditDir);
		const snap = agg.snapshot();

		expect(snap.count).toBe(0);
		expect(snap.successRate).toBe(0);
		expect(snap.totalTokens).toBe(0);
	});

	it("buckets entries by date in trendData", async () => {
		const today = new Date();
		today.setUTCHours(0, 0, 0, 0);
		const yesterday = new Date(today);
		yesterday.setUTCDate(yesterday.getUTCDate() - 1);
		const twoDaysAgo = new Date(today);
		twoDaysAgo.setUTCDate(twoDaysAgo.getUTCDate() - 2);

		const todayStr = today.toISOString().slice(0, 10);
		const yesterdayStr = yesterday.toISOString().slice(0, 10);
		const twoDaysAgoStr = twoDaysAgo.toISOString().slice(0, 10);

		const agg = new MetricsAggregator();
		agg.record(entry("mr", 1000, 0.001, 50_000, `${twoDaysAgoStr}T10:00:00.000Z`));
		agg.record(entry("escalated", 1000, 0.001, 50_000, `${twoDaysAgoStr}T14:00:00.000Z`));
		agg.record(entry("failed", 1000, 0.001, 50_000, `${yesterdayStr}T10:00:00.000Z`));

		const trend = agg.trendData(14);
		const dayTwoAgo = trend.find((d) => d.date === twoDaysAgoStr);
		const dayYesterday = trend.find((d) => d.date === yesterdayStr);

		expect(dayTwoAgo).toEqual({ date: twoDaysAgoStr, success: 1, escalation: 1, failure: 0 });
		expect(dayYesterday).toEqual({ date: yesterdayStr, success: 0, escalation: 0, failure: 1 });
		expect(trend.some((d) => d.date === todayStr)).toBe(true);
	});

	it("returns 14 days with zero-filled gaps", () => {
		const agg = new MetricsAggregator();
		const trend = agg.trendData(14);

		expect(trend).toHaveLength(14);
		expect(trend.every((d) => d.success === 0 && d.escalation === 0 && d.failure === 0)).toBe(true);
	});

	it("recentEntries returns the most recent N entries in chronological order", () => {
		const agg = new MetricsAggregator();
		const entries = [
			entry("mr", 1000, 0.001, 10_000, "2026-08-19T08:00:00.000Z"),
			entry("failed", 1000, 0.001, 20_000, "2026-08-19T09:00:00.000Z"),
			entry("escalated", 1000, 0.001, 30_000, "2026-08-19T10:00:00.000Z"),
		];
		for (const e of entries) agg.record(e);

		expect(agg.recentEntries(2)).toEqual([entries[1], entries[2]]);
	});

	it("recentEntries caps retained entries at 100 by default", () => {
		const agg = new MetricsAggregator();
		for (let i = 0; i < 120; i++) {
			agg.record(entry("mr", 100, 0.001, 1000, `2026-08-19T${String(i % 24).padStart(2, "0")}:00:00.000Z`));
		}

		expect(agg.recentEntries()).toHaveLength(100);
	});
});
