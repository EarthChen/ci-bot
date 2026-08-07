import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import {
	mkdtempSync,
	rmSync,
	existsSync,
	readFileSync,
	mkdirSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, basename } from "node:path";
import { InMemoryDingTalkNotifier } from "../../src/notify/dingtalk.js";
import { finishRepair } from "../../src/pipeline/repair-outcome.js";
import { removeWorktree as realRemoveWorktree } from "../../src/pipeline/worktree.js";
import type { PipelineEvent } from "../../src/types.js";
import {
	repairCost,
	persistDurable,
	metricLine,
	resolveAuditDir,
} from "../../src/pipeline/repair-outcome.js";
import type { AuditTrace } from "../../src/pipeline/repair-outcome.js";

const event: PipelineEvent = {
	projectId: "42",
	pipelineId: 1001,
	ref: "main",
	sha: "abc1234567890",
	projectUrl: "https://git.example.com/g/p",
};

function readTrace(cwd: string): Record<string, unknown> {
	return JSON.parse(readFileSync(join(cwd, "audit-trace.json"), "utf8"));
}

describe("finishRepair — 统一终态 handler", () => {
	let cwd: string;
	let dt: InMemoryDingTalkNotifier;
	let removeCalls: string[];
	let removeWorktree: (cwd: string) => Promise<void>;
	beforeEach(() => {
		cwd = mkdtempSync(join(tmpdir(), "repair-outcome-"));
		dt = new InMemoryDingTalkNotifier();
		removeCalls = [];
		// 注入的清理 seam：记录调用，并委托真实实现以保留"真删 repo"断言
		removeWorktree = vi.fn(async (c: string) => {
			removeCalls.push(c);
			await realRemoveWorktree(c);
		});
	});
	afterEach(() => {
		rmSync(cwd, { recursive: true, force: true });
	});

	it("mr: 写审计 + 成功通知，返回 mr 结果", async () => {
		const out = await finishRepair({
			dingtalk: dt,
			cwd,
			event,
			removeWorktree,
			result: {
				kind: "mr",
				summary: "NPE in Calc",
				diagnosis: { failureClass: 1, summary: "NPE" },
				diff: "diff--",
				mrUrl: "https://mr/1",
				metrics: { turns: 2, tokens: 100, cost: 0.0001, durationMs: 50 },
			},
		});
		expect(out).toEqual({ kind: "mr", mrUrl: "https://mr/1", summary: "NPE" });
		const trace = readTrace(cwd);
		expect(trace.outcome).toBe("mr");
		expect(trace.mrUrl).toBe("https://mr/1");
		expect(trace.diff).toBe("diff--");
		expect(dt.sent).toHaveLength(1);
		expect(dt.sent[0].title).toBe("CI 自愈修复成功");
		expect(removeCalls).toContain(cwd);
	});

	it("escalated: 写审计 + 转交通知", async () => {
		const out = await finishRepair({
			dingtalk: dt,
			cwd,
			event,
			removeWorktree,
			result: {
				kind: "escalated",
				summary: "G3 violation: src/main",
				diagnosis: { failureClass: 3, summary: "x" },
				diff: "d",
				metrics: { turns: 1, tokens: 10, cost: 0, durationMs: 5 },
			},
		});
		expect(out).toEqual({
			kind: "escalated",
			summary: "G3 violation: src/main",
		});
		const trace = readTrace(cwd);
		expect(trace.outcome).toBe("escalated");
		expect(dt.sent[0].title).toBe("CI 自愈转交人工");
		expect(removeCalls).toContain(cwd);
	});

	it("failed: 写 G5 审计（此前缺失）+ 异常通知", async () => {
		const out = await finishRepair({
			dingtalk: dt,
			cwd,
			event,
			removeWorktree,
			result: { kind: "failed", summary: "agent-run", error: "boom" },
		});
		expect(out).toEqual({
			kind: "failed",
			summary: "agent-run failed",
			error: "boom",
		});
		const trace = readTrace(cwd);
		expect(trace.outcome).toBe("failed");
		expect(String(trace.reasoning)).toContain("boom");
		expect(dt.sent[0].title).toBe("CI 自愈 Bot 异常");
		expect(removeCalls).toContain(cwd);
	});

	it("总是 best-effort 清理 <cwd>/repo worktree", async () => {
		mkdirSync(join(cwd, "repo"), { recursive: true });
		await finishRepair({
			dingtalk: dt,
			cwd,
			event,
			removeWorktree,
			result: { kind: "escalated", summary: "x" },
		});
		expect(existsSync(join(cwd, "repo"))).toBe(false);
		expect(removeCalls).toContain(cwd);
	});
});
describe("repairCost — token cost computation", () => {
	it("returns 0 for 0 tokens", () => {
		expect(repairCost(0)).toBe(0);
	});
	it("scales linearly with tokens", () => {
		// default BOT_TOKEN_UNIT_COST_PER_1K = 0.001
		// 1000 tokens = 0.001
		expect(repairCost(1000)).toBe(0.001);
		expect(repairCost(50000)).toBe(0.05);
	});
	it("respects BOT_TOKEN_UNIT_COST_PER_1K env override", async () => {
		const orig = process.env.BOT_TOKEN_UNIT_COST_PER_1K;
		process.env.BOT_TOKEN_UNIT_COST_PER_1K = "0.002";
		// COST_PER_1K_TOKENS is captured at module load; re-import with a
		// cache-busting query so the env override is observed (ESM has no
		// require.cache).
		const fresh = await import(
			"../../src/pipeline/repair-outcome.js?override=" + Date.now()
		);
		const { repairCost: rc } = fresh as typeof import("../../src/pipeline/repair-outcome.js");
		expect(rc(1000)).toBe(0.002);
		if (orig !== undefined) process.env.BOT_TOKEN_UNIT_COST_PER_1K = orig;
		else delete process.env.BOT_TOKEN_UNIT_COST_PER_1K;
	});
});

describe("metricLine — JSONL metric serialization", () => {
	it("produces valid JSON with all required fields", () => {
		const line = metricLine({
			event: { projectId: "42", pipelineId: 1001, ref: "main", sha: "abc12345" },
			outcome: "mr",
			diff: "diff--",
			reasoning: "test",
			createdAt: "2026-08-06T09:00:00.000Z",
			turns: 0,
			tokens: 50000,
			cost: 0.05,
			durationMs: 1200,
		});
		const parsed = JSON.parse(line);
		expect(parsed.projectId).toBe("42");
		expect(parsed.pipelineId).toBe(1001);
		expect(parsed.outcome).toBe("mr");
		expect(parsed.tokens).toBe(50000);
		expect(parsed.cost).toBe(0.05);
		expect(parsed.durationMs).toBe(1200);
		expect(parsed.createdAt).toBe("2026-08-06T09:00:00.000Z");
	});
});

describe("resolveAuditDir — durable audit directory resolution", () => {
	it("derives from CIHEAL_DATA_ROOT/audit", () => {
		const orig = process.env.CIHEAL_DATA_ROOT;
		process.env.CIHEAL_DATA_ROOT = "/tmp/data";
		expect(resolveAuditDir()).toBe("/tmp/data/audit");
		if (orig !== undefined) process.env.CIHEAL_DATA_ROOT = orig;
		else delete process.env.CIHEAL_DATA_ROOT;
	});
});

describe("persistDurable — durable audit trace persistence", () => {
	it("writes audit-trace.json and appends metrics.jsonl under CIHEAL_DATA_ROOT/audit", async () => {
		const dataDir = mkdtempSync(join(tmpdir(), "ci-heal-data-"));
		const origDataRoot = process.env.CIHEAL_DATA_ROOT;
		process.env.CIHEAL_DATA_ROOT = dataDir;
		const trace: AuditTrace = {
			event: { projectId: "42", pipelineId: 1001, ref: "main", sha: "abc12345" },
			outcome: "escalated",
			diff: "diff--",
			reasoning: "test",
			createdAt: "2026-08-06T09:00:00.000Z",
			tokens: 1000,
			cost: 0.001,
			durationMs: 500,
			turns: 1,
		};
		const cwd = mkdtempSync(join(tmpdir(), "ci-heal-work-"));
		const runId = basename(cwd);
		persistDurable(cwd, trace);
		expect(existsSync(join(dataDir, "audit", "1001", runId + "-audit-trace.json"))).toBe(true);
		expect(existsSync(join(dataDir, "audit", "1001", "metrics.jsonl"))).toBe(true);
		const metricsContent = readFileSync(join(dataDir, "audit", "1001", "metrics.jsonl"), "utf8");
		const parsed = JSON.parse(metricsContent.trim());
		expect(parsed.pipelineId).toBe(1001);
		expect(parsed.outcome).toBe("escalated");
		// cleanup
		rmSync(dataDir, { recursive: true, force: true });
		rmSync(cwd, { recursive: true, force: true });
		if (origDataRoot !== undefined) process.env.CIHEAL_DATA_ROOT = origDataRoot;
		else delete process.env.CIHEAL_DATA_ROOT;
	});
	it("is best-effort: does not throw on invalid path", () => {
		expect(() => {
			persistDurable("/nonexistent/deeply/nested/path/that/cannot/be/created", {
				event: { projectId: "1", pipelineId: 1, ref: "r", sha: "s" },
				outcome: "failed",
				diff: "",
				reasoning: "x",
				createdAt: "2026-01-01T00:00:00.000Z",
				tokens: 0,
				cost: 0,
				durationMs: 0,
				turns: 0,
			} as AuditTrace);
		}).not.toThrow();
	});
});

