import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runRepair, extractPatch, parseDiffFiles, buildDiffIndex } from "../../src/pipeline/run-repair.js";
import type { Worktree } from "../../src/pipeline/worktree.js";
import { InMemoryDingTalkNotifier } from "../../src/notify/dingtalk.js";
import type { AgentRunner, AgentRunInput } from "../../src/agent/runner.js";
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
	return {
		run: async () => result,
		continue: async () => result,
		close: () => {},
	};
}

/** stubAgent 变体：close 是 spy（验证终局关闭 → session 存档）。 */
function stubAgentSpyClose(result: AgentResult): {
	agent: AgentRunner;
	close: ReturnType<typeof vi.fn>;
} {
	const close = vi.fn();
	return {
		agent: {
			run: async () => result,
			continue: async () => result,
			close,
		},
		close,
	};
}

/** Spy runner: records run() calls; satisfies the full AgentRunner interface. */
function spyAgent(result: AgentResult): { agent: AgentRunner; run: ReturnType<typeof vi.fn> } {
	const run = vi.fn(async (_input: AgentRunInput): Promise<AgentResult> => result);
	const agent: AgentRunner = {
		run,
		continue: async () => result,
		close: () => {},
	};
	return { agent, run };
}

function stubGlab(opts: {
	fetchCiLog?: (projectId: string, pipelineId: number) => Promise<string>;
} = {}): GitLabClient {
	return {
		fetchCiLog:
			opts.fetchCiLog ?? (async () => "some unit test failure output"),
		fetchMrDiff: async () => "",
		fetchMrPipelineStatus: async () => ({ status: "success", pipelineId: null }),
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

	it("class5 依赖错命中 → escalated，不起 agent / 不建 worktree", async () => {
		const { worktree, remove } = fakeWorktree();
		const dt = new InMemoryDingTalkNotifier();
		const glab = stubGlab({
			fetchCiLog: async () =>
				"[ERROR] Could not resolve dependencies for project de.example:demo:jar:1.0\n" +
				"[ERROR] Could not find artifact com.example:missing:pom:9.9",
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

	it("测试编译错（被测系统签名变更）→ 早筛放行，交给 agent 判 class 2/5", async () => {
		const { worktree } = fakeWorktree();
		const dt = new InMemoryDingTalkNotifier();
		// 真实形状（MR !281 pipeline 100033426）：编译错误全部指向 src/test。
		const glab = stubGlab({
			fetchCiLog: async () =>
				[
					"[INFO] BUILD FAILURE",
					"[ERROR] Failed to execute goal org.apache.maven.plugins:maven-compiler-plugin:3.7.0:testCompile (default-testCompile) on project svc: Compilation failure: Compilation failure: ",
					"[ERROR] /builds/g/p/svc/src/test/java/com/example/FooTest.java:[86,84] cannot find symbol",
					"[ERROR]   symbol:   variable ROOM_GIFT_RANK",
				].join("\n"),
		});
		const { agent, run } = spyAgent({
			kind: "escalated",
			diagnosis: { failureClass: 5, summary: "x" },
			reason: "handoff",
			source: "runtime",
		});
		const out = await runRepair(
			{ agent, glab, dingtalk: dt, cwd, worktree },
			event,
		);
		expect(run).toHaveBeenCalledTimes(1);
		expect(worktree.create).toHaveBeenCalled();
		expect(out.kind).toBe("escalated");
	});

	it("src/main 编译错同样放行给 agent——分类是 agent 的职责，早筛只拦依赖错", async () => {
		const { worktree } = fakeWorktree();
		const dt = new InMemoryDingTalkNotifier();
		const glab = stubGlab({
			fetchCiLog: async () =>
				"[ERROR] /src/main/java/com/example/Calculator.java:[10,20] cannot find symbol\nBUILD FAILURE",
		});
		const { agent, run } = spyAgent({
			kind: "escalated",
			diagnosis: { failureClass: 5, summary: "x" },
			reason: "handoff",
			source: "runtime",
		});
		await runRepair({ agent, glab, dingtalk: dt, cwd, worktree }, event);
		expect(run).toHaveBeenCalledTimes(1);
		expect(worktree.create).toHaveBeenCalled();
	});

	it("依赖错出现在 8KB 之后仍被早筛拦截（全文扫描，无窗口截断）", async () => {
		const { worktree } = fakeWorktree();
		const dt = new InMemoryDingTalkNotifier();
		const pad = "x".repeat(16 * 1024);
		const glab = stubGlab({
			fetchCiLog: async () =>
				`${pad}\n[ERROR] Could not resolve dependencies for project de.example:demo:jar:1.0`,
		});
		const { agent, run } = spyAgent({
			kind: "escalated",
			diagnosis: { failureClass: 1, summary: "x" },
			reason: "handoff",
			source: "runtime",
		});
		const out = await runRepair(
			{ agent, glab, dingtalk: dt, cwd, worktree },
			event,
		);
		expect(out.kind).toBe("escalated");
		expect(run).not.toHaveBeenCalled();
		expect(worktree.create).not.toHaveBeenCalled();
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
		const close = vi.fn();
		const agent: AgentRunner = {
			run: async () => {
				throw new Error("agent boom");
			},
			continue: async () => {
				throw new Error("not used in this test");
			},
			close,
		};
		const out = await runRepair(
			{ agent, glab, dingtalk: dt, cwd, worktree },
			event,
		);
		expect(out.kind).toBe("failed");
		if (out.kind === "failed") expect(out.summary).toContain("agent-run");
		expect(remove).toHaveBeenCalledWith(cwd);
		// session 存档依赖 close（dispose）；agent.run 抛错路径同样不得泄漏 session
		expect(close).toHaveBeenCalledOnce();
	});

	it("agent 返回 runtime escalated（预算/异常）→ 非可决策，清理照常", async () => {
		const { worktree, remove } = fakeWorktree();
		const dt = new InMemoryDingTalkNotifier();
		const glab = stubGlab({ fetchCiLog: async () => "test failure" });
		const agent = stubAgent({
			kind: "escalated",
			diagnosis: { failureClass: 4, summary: "预算超限" },
			reason: "budget exceeded",
			source: "runtime",
		});
		const out = await runRepair(
			{ agent, glab, dingtalk: dt, cwd, worktree },
			event,
		);
		expect(out.kind).toBe("escalated");
		if (out.kind === "escalated") expect(out.decidable).toBeUndefined();
		expect(remove).toHaveBeenCalledWith(cwd);
	});

	it("agent 主动 escalated（source=agent）→ decidable，跳过 worktree 清理", async () => {
		const { worktree, remove } = fakeWorktree();
		const dt = new InMemoryDingTalkNotifier();
		const glab = stubGlab({ fetchCiLog: async () => "test failure" });
		const { agent, close } = stubAgentSpyClose({
			kind: "escalated",
			diagnosis: { failureClass: 3, summary: "spec unreadable" },
			reason: "need human decision",
			source: "agent",
		});
		const out = await runRepair(
			{ agent, glab, dingtalk: dt, cwd, worktree },
			event,
		);
		expect(out.kind).toBe("escalated");
		if (out.kind === "escalated") {
			expect(out.decidable).toBe(true);
			expect(out.diagnosisSummary).toBe("spec unreadable");
		}
		expect(remove).not.toHaveBeenCalled();
		// escalated 终局必须 close：session 存档（agent-session.jsonl）依赖 dispose，
		// run 6（MR !281 静态分析）因缺 close 丢失全部 session 遥测
		expect(close).toHaveBeenCalledOnce();
	});
});

describe("extractPatch", () => {
	const execFileP = promisify(execFile);
	let repo: string;
	beforeEach(() => {
		repo = mkdtempSync(join(tmpdir(), "extract-patch-"));
	});
	afterEach(() => {
		rmSync(repo, { recursive: true, force: true });
	});

	it("提取超过 1MB 的 diff 并排除 spill 文件（MR !281 实测 maxBuffer 崩溃回归）", async () => {
		const git = async (...args: string[]) =>
			(await execFileP("git", args, { cwd: repo })).stdout.trim();
		await execFileP("git", ["init", "--quiet", "-b", "master", repo]);
		await git("config", "user.email", "t@ci-bot");
		await git("config", "user.name", "ci-bot test");
		writeFileSync(join(repo, "seed.txt"), "baseline\n");
		await git("add", "-A");
		await git("commit", "--quiet", "-m", "baseline");
		const baseSha = await git("rev-parse", "HEAD");

		// 模拟 agent 编辑：>1MB 内容（execFile 默认 maxBuffer = 1MB）
		writeFileSync(join(repo, "big-test.txt"), "x".repeat(2 * 1024 * 1024));
		// spill 文件：必须从 patch 中排除
		writeFileSync(join(repo, "ci-log.txt"), "log\n");
		writeFileSync(join(repo, "mr-diff.patch"), "diff\n");

		const patch = await extractPatch(repo, "fix summary", baseSha);
		expect(patch.paths).toContain("big-test.txt");
		expect(patch.paths).not.toContain("ci-log.txt");
		expect(patch.paths).not.toContain("mr-diff.patch");
		expect(patch.diff).not.toContain("ci-log.txt");
		expect(patch.diff.length).toBeGreaterThan(1024 * 1024);
		expect(patch.summary).toBe("fix summary");
	});
});

describe("parseDiffFiles", () => {
	it("解析 `diff --git` 格式", () => {
		expect(
			parseDiffFiles("diff --git a/src/test/Foo.java b/src/test/Foo.java\n"),
		).toEqual(["src/test/Foo.java"]);
	});

	it("解析 glab 统一 `---/+++` 格式（MR !281 实测形状，无 a/ b/ 前缀）", () => {
		const diff = [
			"--- src/main/java/A.java",
			"+++ src/main/java/A.java",
			"@@ -1 +1 @@",
			"--- src/main/java/B.java",
			"+++ src/main/java/B.java",
			"@@ -0,0 +1,3 @@",
		].join("\n");
		expect(parseDiffFiles(diff)).toEqual([
			"src/main/java/A.java",
			"src/main/java/B.java",
		]);
	});

	it("兼容带 a/ b/ 前缀的统一格式", () => {
		const diff = [
			"--- a/src/main/java/A.java",
			"+++ b/src/main/java/A.java",
		].join("\n");
		expect(parseDiffFiles(diff)).toEqual(["src/main/java/A.java"]);
	});

	it("忽略 /dev/null（纯删除文件）", () => {
		expect(parseDiffFiles("--- a/x.java\n+++ /dev/null\n")).toEqual([]);
	});
});

describe("runRepair — 部分修复 MR", () => {
	let cwd: string;
	beforeEach(() => {
		cwd = mkdtempSync(join(tmpdir(), "run-repair-partial-"));
	});
	afterEach(() => {
		rmSync(cwd, { recursive: true, force: true });
	});

	it("escalated 带 mrUrl（agent 已建部分修复 MR）→ outcome 携带 mrUrl", async () => {
		const { worktree, remove } = fakeWorktree();
		const dt = new InMemoryDingTalkNotifier();
		const glab = stubGlab({ fetchCiLog: async () => "test failure" });
		const agent = stubAgent({
			kind: "escalated",
			diagnosis: { failureClass: 3, summary: "根因在 src/main" },
			reason: "class 3 转交",
			source: "agent",
			mrUrl: "https://git.example.com/g/p/-/merge_requests/77",
		});
		const out = await runRepair(
			{ agent, glab, dingtalk: dt, cwd, worktree },
			event,
		);
		expect(out.kind).toBe("escalated");
		if (out.kind === "escalated") {
			expect(out.decidable).toBe(true);
			expect(out.mrUrl).toBe("https://git.example.com/g/p/-/merge_requests/77");
		}
		expect(remove).not.toHaveBeenCalled();
	});
});

describe("buildDiffIndex", () => {
	it("glab 统一格式：逐文件增删行数（MR !281 实测形状）", () => {
		const diff = [
			"--- src/main/java/A.java",
			"+++ src/main/java/A.java",
			"@@ -1,2 +1,3 @@",
			"+added line",
			"-removed line",
			"+added another",
			" context",
			"--- src/test/java/B.java",
			"+++ src/test/java/B.java",
			"@@ -0,0 +1,2 @@",
			"+new test line 1",
			"+new test line 2",
		].join("\n");
		expect(buildDiffIndex(diff)).toBe(
			[
				"MR diff 文件索引（2 个文件）：",
				"src/main/java/A.java  +2 -1",
				"src/test/java/B.java  +2 -0",
			].join("\n"),
		);
	});

	it("diff --git 格式同样支持", () => {
		const diff = ["diff --git a/x.java b/x.java", "@@ -1 +1 @@", "+a"].join("\n");
		expect(buildDiffIndex(diff)).toContain("x.java  +1 -0");
	});

	it("新增/删除文件标注（dev/null 侧）", () => {
		const diff = [
			"--- /dev/null",
			"+++ src/main/java/New.java",
			"@@ -0,0 +1 @@",
			"+x",
			"--- src/main/java/Old.java",
			"+++ /dev/null",
			"@@ -1 +0,0 @@",
			"-y",
		].join("\n");
		const idx = buildDiffIndex(diff);
		expect(idx).toContain("src/main/java/New.java  +1 -0（新增）");
		expect(idx).toContain("src/main/java/Old.java  +0 -1（删除）");
	});

	it("空 diff / 无 diff 标记 → 空字符串（调用方不写索引文件）", () => {
		expect(buildDiffIndex("")).toBe("");
		expect(buildDiffIndex("random text\nno diff markers")).toBe("");
	});
});
