import { describe, it, expect, beforeEach, afterEach } from "vitest";
import {
	mkdtempSync,
	rmSync,
	existsSync,
	readFileSync,
	mkdirSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { InMemoryDingTalkNotifier } from "../../src/notify/dingtalk.js";
import { finishRepair } from "../../src/pipeline/repair-outcome.js";
import type { PipelineEvent } from "../../src/types.js";

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
	beforeEach(() => {
		cwd = mkdtempSync(join(tmpdir(), "repair-outcome-"));
		dt = new InMemoryDingTalkNotifier();
	});
	afterEach(() => {
		rmSync(cwd, { recursive: true, force: true });
	});

	it("mr: 写审计 + 成功通知，返回 mr 结果", async () => {
		const out = await finishRepair({
			dingtalk: dt,
			cwd,
			event,
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
	});

	it("escalated: 写审计 + 转交通知", async () => {
		const out = await finishRepair({
			dingtalk: dt,
			cwd,
			event,
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
	});

	it("failed: 写 G5 审计（此前缺失）+ 异常通知", async () => {
		const out = await finishRepair({
			dingtalk: dt,
			cwd,
			event,
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
	});

	it("总是 best-effort 清理 <cwd>/repo worktree", async () => {
		mkdirSync(join(cwd, "repo"), { recursive: true });
		await finishRepair({
			dingtalk: dt,
			cwd,
			event,
			result: { kind: "escalated", summary: "x" },
		});
		expect(existsSync(join(cwd, "repo"))).toBe(false);
	});
});
