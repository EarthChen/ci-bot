import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync, readFileSync } from "node:fs";
import { execFile, execFileSync } from "node:child_process";
import { promisify } from "node:util";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	runRepair,
	repairFixed,
	extractPatch,
	parseDiffFiles,
	parseDiffHunkRanges,
	isStaticAnalysisStage,
	validatePatchLineScope,
	buildDiffIndex,
	snapshotSceneChanges,
	widenableG3Paths,
	outsideDiffPaths,
} from "../../src/pipeline/run-repair.js";
import type { Worktree, ReplayResult } from "../../src/pipeline/worktree.js";
import { repairBranchName } from "../../src/pipeline/repair-branch.js";
import { InMemoryDingTalkNotifier } from "../../src/notify/dingtalk.js";
import type { AgentRunner, AgentRunInput } from "../../src/agent/runner.js";
import type { GitLabClient } from "../../src/gitlab/glab-client.js";
import type { AgentResult, PipelineEvent } from "../../src/types.js";
import { saveMrSession } from "../../src/pipeline/mr-session-store.js";

const event: PipelineEvent = {
	projectId: "42",
	pipelineId: 1001,
	ref: "main",
	sha: "abc1234567890",
	projectUrl: "https://git.example.com/g/p",
};

/** Fake worktree seam: create returns a fake repo path, remove is a spy. */
function fakeWorktree(): {
	worktree: Worktree;
	remove: ReturnType<typeof vi.fn>;
	pushBranch: ReturnType<typeof vi.fn>;
} {
	const remove = vi.fn(async (_cwd: string) => {});
	const pushBranch = vi.fn(async () => {});
	const worktree: Worktree = {
		create: vi.fn(async (workDir: string) => join(workDir, "repo")),
		remove,
		pushBranch,
		replayChanges: vi.fn(async () => ({ outcome: "skipped" as const })),
	};
	return { worktree, remove, pushBranch };
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
		findMrBySourceBranch: async () => null,
		fetchBranchHeadSha: async () => "deadbeef",
		fetchMrPipelineStatus: async () => ({ status: "success", pipelineId: null }),
		fetchMrState: async () => "open" as const,
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
			pushBranch: async () => {},
			replayChanges: vi.fn(async () => ({ outcome: 'skipped' as const })),
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

	it("排除 mr-diff-index.txt 与 .m2 构建态（MR !281 e2e G3 误杀回归）", async () => {
		const git = async (...args: string[]) =>
			(await execFileP("git", args, { cwd: repo })).stdout.trim();
		await execFileP("git", ["init", "--quiet", "-b", "master", repo]);
		await git("config", "user.email", "t@ci-bot");
		await git("config", "user.name", "ci-bot test");
		writeFileSync(join(repo, "seed.txt"), "baseline\n");
		await git("add", "-A");
		await git("commit", "--quiet", "-m", "baseline");
		const baseSha = await git("rev-parse", "HEAD");

		// agent 的真实修复
		writeFileSync(join(repo, "seed.txt"), "fixed\n");
		// bot 写入 worktree 的 spill 文件（ci-repair-definition 写 mr-diff-index.txt）
		writeFileSync(join(repo, "mr-diff-index.txt"), "index\n");
		writeFileSync(join(repo, "ci-log-100033613.txt"), "log\n");
		// agent 在 worktree 内跑 mvn 产生的 Maven 本地仓库状态（MR !281 实测）
		const m2 = join(repo, ".m2", "repository", "com", "x");
		mkdirSync(m2, { recursive: true });
		writeFileSync(join(m2, "foo.pom.lastUpdated"), "noise\n");

		const patch = await extractPatch(repo, "fix summary", baseSha);
		expect(patch.paths).toEqual(["seed.txt"]);
		expect(patch.diff).toContain("seed.txt");
		expect(patch.diff).not.toContain("mr-diff-index.txt");
		expect(patch.diff).not.toContain(".m2");
		expect(patch.diff).not.toContain("ci-log");
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

describe("snapshotSceneChanges", () => {
	const execFileP = promisify(execFile);

	it("列出 agent 改动的文件（含新增），排除 spill 文件", async () => {
		const dir = mkdtempSync(join(tmpdir(), "ciheal-scene-"));
		try {
			const git = (...args: string[]) => execFileP("git", args, { cwd: dir });
			await git("init", "-q");
			await git("config", "user.email", "t@ci-bot");
			await git("config", "user.name", "ci-bot test");
			writeFileSync(join(dir, "App.java"), "class App {}\n");
			await git("add", "-A");
			await git("commit", "-q", "-m", "baseline");
			// agent 改动：1 个修改 + 1 个新增 + 1 个 spill（不入清单）
			writeFileSync(join(dir, "App.java"), "class App { int x; }\n");
			writeFileSync(join(dir, "NewTest.java"), "class NewTest {}\n");
			writeFileSync(join(dir, "ci-log.txt"), "spill\n");

			const files = await snapshotSceneChanges(dir);

			expect(files).toContain("App.java");
			expect(files).toContain("NewTest.java");
			expect(files).not.toContain("ci-log.txt");
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});

	it("非 git 目录 → 空数组（best-effort，不阻断转交流程）", async () => {
		const dir = mkdtempSync(join(tmpdir(), "ciheal-nogit-"));
		try {
			expect(await snapshotSceneChanges(dir)).toEqual([]);
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});
});

describe("runRepair — ADR-0007 跨 pipeline session 复用", () => {
	let cwd: string;
	let dataRoot: string;
	beforeEach(() => {
		cwd = mkdtempSync(join(tmpdir(), "run-repair-reuse-"));
		dataRoot = mkdtempSync(join(tmpdir(), "run-repair-reuse-data-"));
		process.env.CIHEAL_DATA_ROOT = dataRoot;
	});
	afterEach(() => {
		rmSync(cwd, { recursive: true, force: true });
		rmSync(dataRoot, { recursive: true, force: true });
		delete process.env.CIHEAL_DATA_ROOT;
	});

	const mrEvent: PipelineEvent = { ...event, mrIid: 7 };

	it("命中同 MR 存档 → agent input 注入 reuseSessionFile/reuseMeta", async () => {
		const src = join(dataRoot, "prev-session.jsonl");
		writeFileSync(src, '{"prev":true}\n');
		saveMrSession(mrEvent, src, "mr");

		const { worktree } = fakeWorktree();
		const glab = stubGlab({ fetchCiLog: async () => "test failure" });
		const { agent, run } = spyAgent({
			kind: "escalated",
			diagnosis: { failureClass: 4, summary: "x" },
			reason: "stop",
			source: "runtime",
		});
		await runRepair(
			{ agent, glab, dingtalk: new InMemoryDingTalkNotifier(), cwd, worktree },
			mrEvent,
		);
		expect(run).toHaveBeenCalledTimes(1);
		const input = run.mock.calls[0][0];
		expect(input.reuseSessionFile).toBeTruthy();
		expect(readFileSync(input.reuseSessionFile!, "utf8")).toContain('"prev":true');
		expect(input.reuseMeta).toEqual({ pipelineId: 1001, sha: "abc1234567890" });
		// 审计可追溯：本次修复复用了哪个 pipeline 的 session
		const trace = JSON.parse(
			readFileSync(join(cwd, "audit-trace.json"), "utf8"),
		) as Record<string, unknown>;
		expect(trace.reusedFromPipeline).toBe(1001);
	});

	it("无存档 → input 不带复用字段", async () => {
		const { worktree } = fakeWorktree();
		const glab = stubGlab({ fetchCiLog: async () => "test failure" });
		const { agent, run } = spyAgent({
			kind: "escalated",
			diagnosis: { failureClass: 4, summary: "x" },
			reason: "stop",
			source: "runtime",
		});
		await runRepair(
			{ agent, glab, dingtalk: new InMemoryDingTalkNotifier(), cwd, worktree },
			mrEvent,
		);
		const input = run.mock.calls[0][0];
		expect(input.reuseSessionFile).toBeUndefined();
		expect(input.reuseMeta).toBeUndefined();
	});
});

describe("parseDiffHunkRanges", () => {
	it("标准 diff --git 格式 → 正确提取 file + 行范围", () => {
		const diff = [
			"diff --git a/src/main/Foo.java b/src/main/Foo.java",
			"--- a/src/main/Foo.java",
			"+++ b/src/main/Foo.java",
			"@@ -10,5 +10,8 @@ class Foo {",
		].join("\n");
		const ranges = parseDiffHunkRanges(diff);
		expect(ranges.get("src/main/Foo.java")).toEqual([[10, 17]]);
	});

	it("多文件多 hunk → 每文件多个范围", () => {
		const diff = [
			"diff --git a/src/main/A.java b/src/main/A.java",
			"@@ -1,2 +1,3 @@",
			"diff --git a/src/main/B.java b/src/main/B.java",
			"@@ -5,1 +5,2 @@",
			"@@ -20,3 +20,4 @@",
		].join("\n");
		const ranges = parseDiffHunkRanges(diff);
		expect(ranges.get("src/main/A.java")).toEqual([[1, 3]]);
		expect(ranges.get("src/main/B.java")).toEqual([
			[5, 6],
			[20, 23],
		]);
	});

	it("glab ---/+++ 格式（无 diff --git 头）→ 正确提取", () => {
		const diff = [
			"--- src/main/java/A.java",
			"+++ src/main/java/A.java",
			"@@ -1,2 +1,3 @@",
			"--- src/main/java/B.java",
			"+++ src/main/java/B.java",
			"@@ -0,0 +1,2 @@",
		].join("\n");
		const ranges = parseDiffHunkRanges(diff);
		expect(ranges.get("src/main/java/A.java")).toEqual([[1, 3]]);
		expect(ranges.get("src/main/java/B.java")).toEqual([[1, 2]]);
	});

	it("空 diff → 空 Map", () => {
		expect(parseDiffHunkRanges("")).toEqual(new Map());
	});

	it("@@ -a +b @@（无 count，默认 1）→ 行范围 [b, b]", () => {
		const diff = "diff --git a/x.java b/x.java\n@@ -1 +2 @@\n";
		expect(parseDiffHunkRanges(diff).get("x.java")).toEqual([[2, 2]]);
	});
});

describe("isStaticAnalysisStage", () => {
	it('["checkstyle"] → true', () => {
		expect(isStaticAnalysisStage(["checkstyle"])).toBe(true);
	});

	it('["test", "spotbugs"] → true', () => {
		expect(isStaticAnalysisStage(["test", "spotbugs"])).toBe(true);
	});

	it('["test"] → false', () => {
		expect(isStaticAnalysisStage(["test"])).toBe(false);
	});

	it("undefined → false", () => {
		expect(isStaticAnalysisStage(undefined)).toBe(false);
	});
});

describe("validatePatchLineScope", () => {
	const mrHunks = (): Map<string, Array<[number, number]>> =>
		new Map([["src/main/Foo.java", [[10, 17]]]]);

	it("agent 改动在 MR diff 行范围内 → null", () => {
		const patch = "diff --git a/src/main/Foo.java b/src/main/Foo.java\n@@ -12,1 +12,1 @@\n";
		expect(validatePatchLineScope(patch, mrHunks())).toBeNull();
	});

	it("agent 改动在容忍度内 → null", () => {
		const patch = "diff --git a/src/main/Foo.java b/src/main/Foo.java\n@@ -22,1 +22,1 @@\n";
		expect(validatePatchLineScope(patch, mrHunks(), 5)).toBeNull();
	});

	it("agent 改动超出容忍度 → 返回错误消息", () => {
		const patch = "diff --git a/src/main/Foo.java b/src/main/Foo.java\n@@ -50,3 +50,3 @@\n";
		const err = validatePatchLineScope(patch, mrHunks(), 5);
		expect(err).toMatch(/src\/main\/Foo\.java:50-52/);
		expect(err).toContain("outside MR diff line scope");
	});

	it("测试/文档文件不受限 → null（即使不在行范围）", () => {
		const patch = "diff --git a/src/test/FooTest.java b/src/test/FooTest.java\n@@ -50,3 +50,3 @@\n";
		expect(validatePatchLineScope(patch, mrHunks())).toBeNull();
	});

	it("MR diff 无该文件的 hunk → 返回错误", () => {
		const patch = "diff --git a/src/main/Other.java b/src/main/Other.java\n@@ -1,1 +1,1 @@\n";
		const err = validatePatchLineScope(patch, mrHunks());
		expect(err).toContain("src/main/Other.java");
		expect(err).toContain("outside MR diff line scope");
	});
});

describe("repairFixed — static-analysis 行级 G3", () => {
	const mrEvent: PipelineEvent = {
		...event,
		mrIid: 42,
		mrSourceBranch: "feature/foo",
	};

	const fixedResult: Extract<AgentResult, { kind: "fixed" }> = {
		kind: "fixed",
		diagnosis: { failureClass: 4, summary: "checkstyle" },
		summary: "fix checkstyle",
	};

	function git(args: readonly string[], cwd: string): void {
		execFileSync("git", [...args], { cwd, stdio: "pipe" });
	}

	function seedMainJavaRepo(
		dir: string,
		opts: { modifyLine: number; lineContent: string },
	): string {
		const repoCwd = join(dir, "repo");
		const javaPath = join(repoCwd, "src/main/java/com/example/Foo.java");
		mkdirSync(join(repoCwd, "src/main/java/com/example"), { recursive: true });
		const lines = Array.from({ length: 60 }, (_, i) => `// line ${i + 1}`);
		writeFileSync(javaPath, lines.join("\n") + "\n");
		git(["init", "--quiet"], repoCwd);
		git(["config", "user.email", "ci-self-heal@bot"], repoCwd);
		git(["config", "user.name", "ci-self-heal bot"], repoCwd);
		git(["add", "-A"], repoCwd);
		git(["commit", "--quiet", "-m", "baseline"], repoCwd);
		git(["tag", event.sha, "HEAD"], repoCwd);
		lines[opts.modifyLine - 1] = opts.lineContent;
		writeFileSync(javaPath, lines.join("\n") + "\n");
		return repoCwd;
	}

	const mrDiffHunk = [
		"--- src/main/java/com/example/Foo.java",
		"+++ src/main/java/com/example/Foo.java",
		"@@ -10,5 +10,8 @@",
	].join("\n");

	function glabForLineG3(headSha = event.sha): GitLabClient {
		return {
			fetchCiLog: async () => "checkstyle failure",
			fetchMrDiff: async () => mrDiffHunk,
			findMrBySourceBranch: async () => null,
			fetchBranchHeadSha: async () => headSha,
			fetchMrPipelineStatus: async () => ({ status: "success", pipelineId: null }),
			fetchMrState: async () => "open" as const,
			createMr: async () => ({ url: "https://mr/line-g3" }),
		};
	}

	let cwd: string;

	beforeEach(() => {
		cwd = mkdtempSync(join(tmpdir(), "run-repair-line-g3-"));
	});
	afterEach(() => {
		rmSync(cwd, { recursive: true, force: true });
	});

	async function runLineG3Repair(
		repoCwd: string,
		failedStages: readonly string[] | undefined,
	) {
		const remove = vi.fn(async () => {});
		const worktree: Worktree = {
			create: async () => repoCwd,
			remove,
			pushBranch: vi.fn(async () => {}),
			replayChanges: vi.fn(async () => ({ outcome: 'skipped' as const })),
		};
		const agentInput: AgentRunInput = {
			projectId: mrEvent.projectId,
			pipelineId: mrEvent.pipelineId,
			ref: mrEvent.ref,
			sha: mrEvent.sha,
			ciLog: "",
			mrDiff: mrDiffHunk,
			cwd: repoCwd,
			sourceBranch: repairBranchName(mrEvent),
			targetBranch: mrEvent.mrSourceBranch!,
		};
		return repairFixed({
			deps: {
				agent: stubAgent(fixedResult),
				glab: glabForLineG3(),
				dingtalk: new InMemoryDingTalkNotifier(),
				cwd,
				worktree,
			},
			event: { ...mrEvent, failedStages },
			repoCwd,
			result: fixedResult,
			diffFiles: ["src/main/java/com/example/Foo.java"],
			mrDiff: mrDiffHunk,
			agentInput,
			agentMetrics: { turns: 1, tokens: 100, cost: 0, durationMs: 50 },
		});
	}

	it("static-analysis stage + 行级违规 → escalated", async () => {
		const repoCwd = seedMainJavaRepo(cwd, {
			modifyLine: 50,
			lineContent: "// agent fix far away",
		});
		const out = await runLineG3Repair(repoCwd, ["checkstyle"]);
		expect(out.kind).toBe("escalated");
		if (out.kind === "escalated") {
			expect(out.summary).toContain("G3/line-scope");
			expect(out.summary).toContain("outside MR diff line scope");
		}
	});

	it("static-analysis stage + 行级通过 → 正常 MR", async () => {
		const repoCwd = seedMainJavaRepo(cwd, {
			modifyLine: 12,
			lineContent: "// agent fix in hunk",
		});
		const out = await runLineG3Repair(repoCwd, ["checkstyle"]);
		expect(out.kind).toBe("mr");
	});

	it("非 static-analysis stage → 跳过行级（文件级通过即可）", async () => {
		const repoCwd = seedMainJavaRepo(cwd, {
			modifyLine: 50,
			lineContent: "// agent fix far away",
		});
		const out = await runLineG3Repair(repoCwd, ["test"]);
		expect(out.kind).toBe("mr");
	});
});

describe("outsideDiffPaths / widenableG3Paths — G3 扩围判定（ADR-0009）", () => {
	const patch = (paths: readonly string[]) => ({
		diff: "",
		paths,
		summary: "s",
	});
	const diffFiles = ["src/main/java/A.java", "docs/x.md"];

	it("outsideDiffPaths：返回 MR diff 外文件；无 diff 上下文时为空", () => {
		expect(
			outsideDiffPaths(
				patch(["src/main/java/A.java", "m/src/test/java/TTest.java"]),
				diffFiles,
			),
		).toEqual(["m/src/test/java/TTest.java"]);
		expect(outsideDiffPaths(patch(["a"]), [])).toEqual([]);
	});

	it("widenable：diff 外全为测试/文档 → 返回清单", () => {
		expect(
			widenableG3Paths(
				patch(["src/main/java/A.java", "m/src/test/java/TTest.java", "docs/guide.md"]),
				diffFiles,
			),
		).toEqual(["m/src/test/java/TTest.java", "docs/guide.md"]);
	});

	it("不可扩围：混入 diff 外 src/main → null（铁律）", () => {
		expect(
			widenableG3Paths(patch(["other/src/main/java/B.java"]), diffFiles),
		).toBeNull();
	});

	it("不可扩围：碰 build/CI 配置 → null（即使其余全是测试）", () => {
		expect(
			widenableG3Paths(patch(["pom.xml", "m/src/test/java/TTest.java"]), diffFiles),
		).toBeNull();
	});

	it("无需扩围：patch 全在 diff 内 → null", () => {
		expect(widenableG3Paths(patch(["src/main/java/A.java"]), diffFiles)).toBeNull();
	});
});

describe("runRepair — 终局新鲜度闸门（ticket 07）", () => {
	const mrEvent: PipelineEvent = {
		...event,
		mrIid: 42,
		mrSourceBranch: "feature/foo",
	};

	const fixedWithMr: Extract<AgentResult, { kind: "fixed" }> = {
		kind: "fixed",
		diagnosis: { failureClass: 1, summary: "断言错误" },
		summary: "修正断言",
		mrUrl: "https://gitlab.example.com/g/p/-/merge_requests/9",
	};

	function git(args: readonly string[], cwd: string): void {
		execFileSync("git", [...args], { cwd, stdio: "pipe" });
	}

	/** Seed worktree repo at <dir>/repo with event.sha tag for extractPatch. */
	function seedFixedRepo(dir: string): string {
		const repoCwd = join(dir, "repo");
		mkdirSync(join(repoCwd, "src/test/java/com/example"), { recursive: true });
		writeFileSync(
			join(repoCwd, "src/test/java/com/example/FooTest.java"),
			"// baseline\n",
		);
		git(["init", "--quiet"], repoCwd);
		git(["config", "user.email", "ci-self-heal@bot"], repoCwd);
		git(["config", "user.name", "ci-self-heal bot"], repoCwd);
		git(["add", "-A"], repoCwd);
		git(["commit", "--quiet", "-m", "baseline"], repoCwd);
		git(["tag", event.sha, "HEAD"], repoCwd);
		writeFileSync(
			join(repoCwd, "src/test/java/com/example/FooTest.java"),
			"// agent fix\n",
		);
		return repoCwd;
	}

	function glabWithHead(opts: {
		headSha: string | (() => Promise<string>);
		createMr?: GitLabClient["createMr"];
	}): GitLabClient {
		const createMr =
			opts.createMr ??
			(vi.fn(async () => ({ url: "https://mr/bot-created" })) as GitLabClient["createMr"]);
		const headSha = opts.headSha;
		const fetchBranchHeadSha =
			typeof headSha === "function" ? headSha : async () => headSha;
		return {
			fetchCiLog: async () => "test failure",
			fetchMrDiff: async () =>
				"--- src/test/java/com/example/FooTest.java\n+++ src/test/java/com/example/FooTest.java\n",
			findMrBySourceBranch: async () => null,
			fetchBranchHeadSha,
			fetchMrPipelineStatus: async () => ({ status: "success", pipelineId: null }),
			fetchMrState: async () => "open" as const,
			createMr,
		};
	}

	let cwd: string;
	let repoCwd: string;

	beforeEach(() => {
		cwd = mkdtempSync(join(tmpdir(), "run-repair-freshness-"));
		repoCwd = seedFixedRepo(cwd);
	});
	afterEach(() => {
		rmSync(cwd, { recursive: true, force: true });
	});

	async function runFixedPath(glab: GitLabClient, dt: InMemoryDingTalkNotifier) {
		const remove = vi.fn(async () => {});
		const pushBranch = vi.fn(async () => {});
		const worktree: Worktree = {
			create: async () => repoCwd,
			remove,
			pushBranch,
			replayChanges: vi.fn(async () => ({ outcome: 'skipped' as const })),
		};
		const agentInput: AgentRunInput = {
			projectId: mrEvent.projectId,
			pipelineId: mrEvent.pipelineId,
			ref: mrEvent.ref,
			sha: mrEvent.sha,
			ciLog: "",
			mrDiff: "",
			cwd: repoCwd,
			sourceBranch: repairBranchName(mrEvent),
			targetBranch: mrEvent.mrSourceBranch!,
		};
		return repairFixed({
			deps: {
				agent: stubAgent(fixedWithMr),
				glab,
				dingtalk: dt,
				cwd,
				worktree,
			},
			event: mrEvent,
			repoCwd,
			result: fixedWithMr,
			diffFiles: ["src/test/java/com/example/FooTest.java"],
			agentInput,
			agentMetrics: { turns: 1, tokens: 100, cost: 0, durationMs: 50 },
		});
	}

	it("基线已被新提交取代 → 不开 MR、发通知、记审计", async () => {
		const dt = new InMemoryDingTalkNotifier();
		const createMr = vi.fn(async () => ({ url: "https://mr/should-not-create" }));
		const out = await runFixedPath(
			glabWithHead({ headSha: "newer9999999999", createMr }),
			dt,
		);
		expect(out.kind).toBe("failed");
		if (out.kind === "failed") {
			expect(out.error).toBe("baseline_superseded");
			expect(out.summary).toContain("基线已被新提交取代");
		}
		expect(createMr).not.toHaveBeenCalled();
		expect(dt.sent.length).toBeGreaterThan(0);
		expect(dt.sent.some((m) => m.text.includes("baseline_superseded"))).toBe(true);
		const trace = JSON.parse(readFileSync(join(cwd, "audit-trace.json"), "utf8"));
		expect(trace.outcome).toBe("failed");
		expect(trace.reasoning).toContain("baseline_superseded");
	});

	it("基线与 MR 源分支 HEAD 一致 → MR 终局照常", async () => {
		const dt = new InMemoryDingTalkNotifier();
		const createMr = vi.fn(async () => ({ url: "https://mr/bot-created" }));
		const out = await runFixedPath(glabWithHead({ headSha: event.sha, createMr }), dt);
		expect(out.kind).toBe("mr");
		if (out.kind === "mr") {
			expect(out.mrUrl).toBe("https://mr/bot-created");
		}
		expect(createMr).toHaveBeenCalledTimes(1);
	});

	it("escalated 终局不经过新鲜度闸门（fetchBranchHeadSha 不被调用）", async () => {
		const fetchBranchHeadSha = vi.fn(async () => "newer9999999999");
		const { worktree, remove } = fakeWorktree();
		const dt = new InMemoryDingTalkNotifier();
		const glab = glabWithHead({ headSha: fetchBranchHeadSha });
		const agent = stubAgent({
			kind: "escalated",
			diagnosis: { failureClass: 3, summary: "需人工决策" },
			reason: "uncertain",
			source: "agent",
		});
		await runRepair({ agent, glab, dingtalk: dt, cwd, worktree }, mrEvent);
		expect(fetchBranchHeadSha).not.toHaveBeenCalled();
		expect(remove).not.toHaveBeenCalled();
	});

	it("fetchBranchHeadSha 抛异常 → 降级放行，MR 终局照常", async () => {
		const dt = new InMemoryDingTalkNotifier();
		const out = await runFixedPath(
			glabWithHead({
				headSha: async () => {
					throw new Error("glab api down");
				},
			}),
			dt,
		);
		expect(out.kind).toBe("mr");
	});
});

describe("runRepair — 修复 MR 恒一（ticket 08）", () => {
	const mrEvent: PipelineEvent = {
		...event,
		mrIid: 42,
		mrSourceBranch: "feature/foo",
	};

	const fixedWithMr: Extract<AgentResult, { kind: "fixed" }> = {
		kind: "fixed",
		diagnosis: { failureClass: 1, summary: "断言错误" },
		summary: "修正断言",
		mrUrl: "https://gitlab.example.com/g/p/-/merge_requests/9",
	};

	const existingOpenMr = {
		status: "opened" as const,
		iid: 9,
		url: "https://gitlab.example.com/g/p/-/merge_requests/9",
	};

	function git(args: readonly string[], cwd: string): void {
		execFileSync("git", [...args], { cwd, stdio: "pipe" });
	}

	function seedFixedRepo(dir: string): string {
		const repoCwd = join(dir, "repo");
		mkdirSync(join(repoCwd, "src/test/java/com/example"), { recursive: true });
		writeFileSync(
			join(repoCwd, "src/test/java/com/example/FooTest.java"),
			"// baseline\n",
		);
		git(["init", "--quiet"], repoCwd);
		git(["config", "user.email", "ci-self-heal@bot"], repoCwd);
		git(["config", "user.name", "ci-self-heal bot"], repoCwd);
		git(["add", "-A"], repoCwd);
		git(["commit", "--quiet", "-m", "baseline"], repoCwd);
		git(["tag", event.sha, "HEAD"], repoCwd);
		writeFileSync(
			join(repoCwd, "src/test/java/com/example/FooTest.java"),
			"// agent fix\n",
		);
		return repoCwd;
	}

	function glabForMrConvergence(opts: {
		findMrBySourceBranch: GitLabClient["findMrBySourceBranch"];
		createMr?: GitLabClient["createMr"];
		headSha?: string;
	}): GitLabClient {
		const createMr =
			opts.createMr ??
			(vi.fn(async () => ({
				url: "https://gitlab.example.com/g/p/-/merge_requests/99",
			})) as GitLabClient["createMr"]);
		return {
			fetchCiLog: async () => "test failure",
			fetchMrDiff: async () =>
				"--- src/test/java/com/example/FooTest.java\n+++ src/test/java/com/example/FooTest.java\n",
			findMrBySourceBranch: opts.findMrBySourceBranch,
			fetchBranchHeadSha: async () => opts.headSha ?? event.sha,
			fetchMrPipelineStatus: async () => ({ status: "success", pipelineId: null }),
			fetchMrState: async () => "open" as const,
			createMr,
		};
	}

	let cwd: string;
	let repoCwd: string;

	beforeEach(() => {
		cwd = mkdtempSync(join(tmpdir(), "run-repair-single-mr-"));
		repoCwd = seedFixedRepo(cwd);
	});
	afterEach(() => {
		rmSync(cwd, { recursive: true, force: true });
	});

	async function runFixedPath(
		glab: GitLabClient,
		dt: InMemoryDingTalkNotifier,
		pushBranch = vi.fn(async () => {}),
	) {
		const remove = vi.fn(async () => {});
		const worktree: Worktree = {
			create: async () => repoCwd,
			remove,
			pushBranch,
			replayChanges: vi.fn(async () => ({ outcome: 'skipped' as const })),
		};
		const agentInput: AgentRunInput = {
			projectId: mrEvent.projectId,
			pipelineId: mrEvent.pipelineId,
			ref: mrEvent.ref,
			sha: mrEvent.sha,
			ciLog: "",
			mrDiff: "",
			cwd: repoCwd,
			sourceBranch: "ci-self-heal/feature/foo",
			targetBranch: mrEvent.mrSourceBranch!,
		};
		return repairFixed({
			deps: {
				agent: stubAgent(fixedWithMr),
				glab,
				dingtalk: dt,
				cwd,
				worktree,
			},
			event: mrEvent,
			repoCwd,
			result: fixedWithMr,
			diffFiles: ["src/test/java/com/example/FooTest.java"],
			agentInput,
			agentMetrics: { turns: 1, tokens: 100, cost: 0, durationMs: 50 },
		});
	}

	it("已有 open 修复 MR → push 更新、不调用 createMr、返回已有 MR URL", async () => {
		const dt = new InMemoryDingTalkNotifier();
		const createMr = vi.fn(async () => ({ url: "https://mr/should-not-create" }));
		const pushBranch = vi.fn(async () => {});
		const findMrBySourceBranch = vi.fn(async () => existingOpenMr);
		const out = await runFixedPath(
			glabForMrConvergence({ findMrBySourceBranch, createMr }),
			dt,
			pushBranch,
		);
		expect(out.kind).toBe("mr");
		if (out.kind === "mr") {
			expect(out.mrUrl).toBe(existingOpenMr.url);
		}
		expect(createMr).not.toHaveBeenCalled();
		expect(pushBranch).toHaveBeenCalledWith(repoCwd, "ci-self-heal/feature/foo");
		expect(findMrBySourceBranch).toHaveBeenCalledWith(
			mrEvent.projectId,
			"ci-self-heal/feature/foo",
		);
	});

	it("上一个修复 MR 被关闭 → 新开 MR 且描述注明拒绝语境", async () => {
		const dt = new InMemoryDingTalkNotifier();
		const closedMr = {
			status: "closed" as const,
			iid: 5,
			url: "https://gitlab.example.com/g/p/-/merge_requests/5",
		};
		const createMr = vi.fn(async (_params: Parameters<GitLabClient["createMr"]>[0]) => ({
			url: "https://gitlab.example.com/g/p/-/merge_requests/100",
		}));
		const out = await runFixedPath(
			glabForMrConvergence({
				findMrBySourceBranch: async () => closedMr,
				createMr,
			}),
			dt,
		);
		expect(out.kind).toBe("mr");
		expect(createMr).toHaveBeenCalledTimes(1);
		const params = createMr.mock.calls[0]![0];
		expect(params.descriptionPrefix).toContain("上一个修复 MR !5 被关闭");
		expect(dt.sent.some((m) => m.text.includes("上一个修复 MR !5 被关闭"))).toBe(
			true,
		);
	});

	it("merged 或不存在 → 正常新开 MR", async () => {
		const dt = new InMemoryDingTalkNotifier();
		const createMr = vi.fn(async (_params: Parameters<GitLabClient["createMr"]>[0]) => ({
			url: "https://gitlab.example.com/g/p/-/merge_requests/101",
		}));
		const mergedMr = {
			status: "merged" as const,
			iid: 3,
			url: "https://gitlab.example.com/g/p/-/merge_requests/3",
		};
		const outMerged = await runFixedPath(
			glabForMrConvergence({
				findMrBySourceBranch: async () => mergedMr,
				createMr,
			}),
			dt,
		);
		expect(outMerged.kind).toBe("mr");
		expect(createMr).toHaveBeenCalledTimes(1);
		expect(createMr.mock.calls[0]![0].sourceBranch).toBe("ci-self-heal/feature/foo");

		createMr.mockClear();
		const createMrFresh = vi.fn(async () => ({
			url: "https://gitlab.example.com/g/p/-/merge_requests/102",
		}));
		const outFresh = await runFixedPath(
			glabForMrConvergence({
				findMrBySourceBranch: async () => null,
				createMr: createMrFresh,
			}),
			dt,
		);
		expect(outFresh.kind).toBe("mr");
		expect(createMrFresh).toHaveBeenCalledTimes(1);
	});
});

describe("runRepair — ADR-0012 修复重放", () => {
	let cwd: string;
	let dataRoot: string;
	beforeEach(() => {
		cwd = mkdtempSync(join(tmpdir(), "run-repair-replay-"));
		dataRoot = mkdtempSync(join(tmpdir(), "run-repair-replay-data-"));
		process.env.CIHEAL_DATA_ROOT = dataRoot;
	});
	afterEach(() => {
		rmSync(cwd, { recursive: true, force: true });
		rmSync(dataRoot, { recursive: true, force: true });
		delete process.env.CIHEAL_DATA_ROOT;
	});

	const mrEvent: PipelineEvent = { ...event, mrIid: 7 };

	function fakeWorktreeWithReplay(outcome: ReplayResult["outcome"]) {
		const replayChanges = vi.fn(
			async (_args: { repoCwd: string; branch: string; baseSha: string }) => ({
				outcome,
				...(outcome === "applied" ? { commitRange: "abc12345..def67890" } : {}),
			}),
		);
		const remove = vi.fn(async (_cwd: string) => {});
		const pushBranch = vi.fn(async () => {});
		const worktree: Worktree = {
			create: vi.fn(async (workDir: string) => join(workDir, "repo")),
			remove,
			pushBranch,
			replayChanges,
		};
		return { worktree, replayChanges };
	}

	it("有存档 + applied → agent input 注入 replay，审计记重放来源", async () => {
		const src = join(dataRoot, "prev-session.jsonl");
		writeFileSync(src, '{"prev":true}\n');
		saveMrSession(mrEvent, src, "mr");

		const { worktree, replayChanges } = fakeWorktreeWithReplay("applied");
		const glab = stubGlab({ fetchCiLog: async () => "test failure" });
		const { agent, run } = spyAgent({
			kind: "escalated",
			diagnosis: { failureClass: 4, summary: "x" },
			reason: "stop",
			source: "runtime",
		});
		await runRepair(
			{ agent, glab, dingtalk: new InMemoryDingTalkNotifier(), cwd, worktree },
			mrEvent,
		);

		expect(replayChanges).toHaveBeenCalledOnce();
		expect(replayChanges.mock.calls[0]?.[0]?.baseSha).toBe("abc1234567890");
		const input = run.mock.calls[0][0];
		expect(input.replay).toEqual({ outcome: "applied", fromPipeline: 1001 });
		const trace = JSON.parse(
			readFileSync(join(cwd, "audit-trace.json"), "utf8"),
		) as Record<string, unknown>;
		expect(trace.replay).toEqual({
			fromPipeline: 1001,
			commitRange: "abc12345..def67890",
			outcome: "applied",
		});
	});

	it("conflict → agent input 不注入 replay（全新诊断），审计记 conflict", async () => {
		const src = join(dataRoot, "prev-session.jsonl");
		writeFileSync(src, '{"prev":true}\n');
		saveMrSession(mrEvent, src, "mr");

		const { worktree, replayChanges } = fakeWorktreeWithReplay("conflict");
		const glab = stubGlab({ fetchCiLog: async () => "test failure" });
		const { agent, run } = spyAgent({
			kind: "escalated",
			diagnosis: { failureClass: 4, summary: "x" },
			reason: "stop",
			source: "runtime",
		});
		await runRepair(
			{ agent, glab, dingtalk: new InMemoryDingTalkNotifier(), cwd, worktree },
			mrEvent,
		);

		expect(replayChanges).toHaveBeenCalledOnce();
		expect(run.mock.calls[0][0].replay).toBeUndefined();
		const trace = JSON.parse(
			readFileSync(join(cwd, "audit-trace.json"), "utf8"),
		) as Record<string, unknown>;
		expect((trace.replay as Record<string, unknown>).outcome).toBe("conflict");
	});

	it("无存档 → 不调 replayChanges", async () => {
		const { worktree, replayChanges } = fakeWorktreeWithReplay("applied");
		const glab = stubGlab({ fetchCiLog: async () => "test failure" });
		const { agent, run } = spyAgent({
			kind: "escalated",
			diagnosis: { failureClass: 4, summary: "x" },
			reason: "stop",
			source: "runtime",
		});
		await runRepair(
			{ agent, glab, dingtalk: new InMemoryDingTalkNotifier(), cwd, worktree },
			mrEvent,
		);

		expect(replayChanges).not.toHaveBeenCalled();
		expect(run.mock.calls[0][0].replay).toBeUndefined();
	});

	it("无 mrIid 的 push pipeline → 不调 replayChanges", async () => {
		const src = join(dataRoot, "prev-session.jsonl");
		writeFileSync(src, '{"prev":true}\n');
		saveMrSession(event, src, "mr");

		const { worktree, replayChanges } = fakeWorktreeWithReplay("applied");
		const glab = stubGlab({ fetchCiLog: async () => "test failure" });
		const { agent, run } = spyAgent({
			kind: "escalated",
			diagnosis: { failureClass: 4, summary: "x" },
			reason: "stop",
			source: "runtime",
		});
		await runRepair(
			{ agent, glab, dingtalk: new InMemoryDingTalkNotifier(), cwd, worktree },
			event,
		);

		expect(replayChanges).not.toHaveBeenCalled();
		expect(run.mock.calls[0][0].replay).toBeUndefined();
	});
});
