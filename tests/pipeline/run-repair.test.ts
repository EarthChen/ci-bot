import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runRepair } from "../../src/pipeline/run-repair.js";
import type { Worktree } from "../../src/pipeline/worktree.js";
import { InMemoryDingTalkNotifier } from "../../src/notify/dingtalk.js";
import type { AgentRunner } from "../../src/agent/runner.js";
import type { GitLabClient } from "../../src/gitlab/glab-client.js";
import type { AgentResult, PipelineEvent } from "../../src/types.js";

const event: PipelineEvent = {
	projectId: "42",
	pipelineId: 1001,
	ref: "main",
	sha: "abc1234567890",
	projectUrl: "https://git.example.com/g/p",
};

/** Fake worktree seam: create returns a fake repo path, remove is a spy. */
function fakeWorktree(): { worktree: Worktree; remove: ReturnType<typeof vi.fn> } {
	const remove = vi.fn(async (_cwd: string) => {});
	const worktree: Worktree = {
		create: vi.fn(async (workDir: string) => join(workDir, "repo")),
		remove,
	};
	return { worktree, remove };
}

function stubAgent(result: AgentResult): AgentRunner {
	return { run: async () => result };
}

function stubGlab(opts: {
	fetchCiLog?: (projectId: string, pipelineId: number) => Promise<string>;
} = {}): GitLabClient {
	return {
		fetchCiLog:
			opts.fetchCiLog ?? (async () => "some unit test failure output"),
		fetchMrDiff: async () => "",
		createMr: async () => ({ url: "https://mr/x" }),
	};
}

describe("runRepair — 编排 + worktree seam", () => {
	let cwd: string;
	beforeEach(() => {
		cwd = mkdtempSync(join(tmpdir(), "run-repair-"));
	});
	afterEach(() => {
		rmSync(cwd, { recursive: true, force: true });
	});

	it("fetch-ci-log 抛错 → failed，且清理经注入 seam", async () => {
		const { worktree, remove } = fakeWorktree();
		const dt = new InMemoryDingTalkNotifier();
		const glab = stubGlab({
			fetchCiLog: async () => {
				throw new Error("no log");
			},
		});
		const out = await runRepair(
			{ agent: stubAgent({ kind: "fixed", diagnosis: { failureClass: 1, summary: "x" }, summary: "y" }), glab, dingtalk: dt, cwd, worktree },
			event,
		);
		expect(out.kind).toBe("failed");
		if (out.kind === "failed") expect(out.summary).toContain("fetch-ci-log");
		expect(remove).toHaveBeenCalledWith(cwd);
	});

	it("class5 命中 → escalated，不起 agent / 不建 worktree", async () => {
		const { worktree, remove } = fakeWorktree();
		const dt = new InMemoryDingTalkNotifier();
		const glab = stubGlab({
			fetchCiLog: async () => "BUILD FAILURE Compilation failure in X",
		});
		const agent = stubAgent({ kind: "fixed", diagnosis: { failureClass: 1, summary: "x" }, summary: "y" });
		const out = await runRepair(
			{ agent, glab, dingtalk: dt, cwd, worktree },
			event,
		);
		expect(out.kind).toBe("escalated");
		expect(worktree.create).not.toHaveBeenCalled();
		expect(remove).toHaveBeenCalledWith(cwd);
	});

	it("worktree.create 抛错 → failed，清理仍执行", async () => {
		const remove = vi.fn(async (_cwd: string) => {});
		const worktree: Worktree = {
			create: async () => {
				throw new Error("clone failed");
			},
			remove,
		};
		const dt = new InMemoryDingTalkNotifier();
		const glab = stubGlab({ fetchCiLog: async () => "test failure" });
		const out = await runRepair(
			{ agent: stubAgent({ kind: "fixed", diagnosis: { failureClass: 1, summary: "x" }, summary: "y" }), glab, dingtalk: dt, cwd, worktree },
			event,
		);
		expect(out.kind).toBe("failed");
		if (out.kind === "failed") expect(out.summary).toContain("worktree");
		expect(remove).toHaveBeenCalledWith(cwd);
	});

	it("agent.run 抛错 → failed", async () => {
		const { worktree, remove } = fakeWorktree();
		const dt = new InMemoryDingTalkNotifier();
		const glab = stubGlab({ fetchCiLog: async () => "test failure" });
		const agent: AgentRunner = {
			run: async () => {
				throw new Error("agent boom");
			},
		};
		const out = await runRepair(
			{ agent, glab, dingtalk: dt, cwd, worktree },
			event,
		);
		expect(out.kind).toBe("failed");
		if (out.kind === "failed") expect(out.summary).toContain("agent-run");
		expect(remove).toHaveBeenCalledWith(cwd);
	});

	it("agent 返回 escalated → escalated", async () => {
		const { worktree, remove } = fakeWorktree();
		const dt = new InMemoryDingTalkNotifier();
		const glab = stubGlab({ fetchCiLog: async () => "test failure" });
		const agent = stubAgent({
			kind: "escalated",
			diagnosis: { failureClass: 3, summary: "x" },
			reason: "G3",
		});
		const out = await runRepair(
			{ agent, glab, dingtalk: dt, cwd, worktree },
			event,
		);
		expect(out.kind).toBe("escalated");
		expect(remove).toHaveBeenCalledWith(cwd);
	});
});
