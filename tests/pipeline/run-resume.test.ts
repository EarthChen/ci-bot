import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { execFileSync } from "node:child_process";
import {
	existsSync,
	mkdirSync,
	mkdtempSync,
	readFileSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runResumeRepair } from "../../src/pipeline/run-resume.js";
import type { Worktree } from "../../src/pipeline/worktree.js";
import { InMemoryDingTalkNotifier } from "../../src/notify/dingtalk.js";
import type { AgentRunner, ResumeDecision } from "../../src/agent/runner.js";
import type { GitLabClient } from "../../src/gitlab/glab-client.js";
import type { AgentResult, PipelineEvent } from "../../src/types.js";

const event: PipelineEvent = {
	projectId: "42",
	pipelineId: 1001,
	ref: "main",
	sha: "abc1234567890",
	projectUrl: "https://git.example.com/g/p",
};

const decision: ResumeDecision = { value: "test", remark: "spec 规定应为 5" };

function git(args: readonly string[], cwd: string): void {
	execFileSync("git", [...args], { cwd, stdio: "pipe" });
}

/** Seed a retained repo at <dir>/repo mirroring fakeWorktree (git + sha tag). */
function seedRetainedRepo(dir: string): string {
	const repoCwd = join(dir, "repo");
	mkdirSync(join(repoCwd, "src/main/java/com/example"), { recursive: true });
	mkdirSync(join(repoCwd, "src/test/java/com/example"), { recursive: true });
	writeFileSync(
		join(repoCwd, "src/main/java/com/example/Calculator.java"),
		"package com.example;\npublic class Calculator {}\n",
	);
	writeFileSync(
		join(repoCwd, "src/test/java/com/example/CalculatorTest.java"),
		"package com.example;\n// stale\n",
	);
	git(["init", "--quiet"], repoCwd);
	git(["config", "user.email", "ci-self-heal@bot"], repoCwd);
	git(["config", "user.name", "ci-self-heal bot"], repoCwd);
	git(["add", "-A"], repoCwd);
	git(["commit", "--quiet", "-m", "baseline"], repoCwd);
	git(["tag", event.sha, "HEAD"], repoCwd);
	return repoCwd;
}

/** Worktree seam pointing at the seeded retained repo (no create on resume). */
function retainedWorktree(repoCwd: string): {
	worktree: Worktree;
	removeCalls: string[];
} {
	const removeCalls: string[] = [];
	const worktree: Worktree = {
		create: async () => {
			throw new Error("resume must not create a worktree");
		},
		remove: async (cwd: string) => {
			removeCalls.push(cwd);
		},
	};
	void repoCwd;
	return { worktree, removeCalls };
}

function stubGlab(): GitLabClient {
	return {
		fetchCiLog: async () => "test failure",
		fetchMrDiff: async () => "",
		fetchMrPipelineStatus: async () => ({ status: "success", pipelineId: 999 }),
		createMr: async () => ({ url: "https://mr/x" }),
	};
}

/** Stub runner whose resume writes canned files into the retained repo. */
function resumeAgent(opts: {
	result: AgentResult;
	writeTest?: boolean;
	writeSrcMain?: boolean;
}): AgentRunner {
	const result = opts.result;
	return {
		run: async () => result,
		continue: async () => result,
		close: () => {},
		resume: async (input) => {
			if (opts.writeTest) {
				writeFileSync(
					join(input.cwd, "src/test/java/com/example/CalculatorTest.java"),
					"package com.example;\n// resumed fix: assertEquals(5, ...)\n",
				);
			}
			if (opts.writeSrcMain) {
				writeFileSync(
					join(input.cwd, "src/main/java/com/example/Calculator.java"),
					"package com.example;\n// resumed production change — G3 must reject\n",
				);
			}
			return result;
		},
	};
}

const fixedWithMr: AgentResult = {
	kind: "fixed",
	diagnosis: { failureClass: 1, summary: "断言错误" },
	summary: "resume 修正断言",
	mrUrl: "https://gitlab.example.com/g/p/-/merge_requests/9",
};

describe("runResumeRepair — 恢复编排（T06）", () => {
	let cwd: string;
	let repoCwd: string;

	beforeEach(() => {
		cwd = mkdtempSync(join(tmpdir(), "run-resume-"));
		repoCwd = seedRetainedRepo(cwd);
	});
	afterEach(() => {
		rmSync(cwd, { recursive: true, force: true });
	});

	function deps(agent: AgentRunner) {
		const { worktree, removeCalls } = retainedWorktree(repoCwd);
		return {
			deps: {
				agent,
				glab: stubGlab(),
				dingtalk: new InMemoryDingTalkNotifier(),
				cwd,
				worktree,
			},
			removeCalls,
		};
	}

	it("resume fixed → extractPatch → G3 → MR 产出（复用后半段管线）", async () => {
		const { deps: d } = deps(
			resumeAgent({ result: fixedWithMr, writeTest: true }),
		);
		const out = await runResumeRepair(d, event, {
			decisionId: "D-1001-ab12",
			...decision,
		});
		expect(out.kind).toBe("mr");
		if (out.kind === "mr") {
			expect(out.mrUrl).toBe(
				"https://gitlab.example.com/g/p/-/merge_requests/9",
			);
		}
	});

	it("audit 记录 decisionId + chainDepth=1", async () => {
		const { deps: d } = deps(
			resumeAgent({ result: fixedWithMr, writeTest: true }),
		);
		await runResumeRepair(d, event, { decisionId: "D-1001-ab12", ...decision });
		const trace = JSON.parse(
			readFileSync(join(cwd, "audit-trace.json"), "utf8"),
		);
		expect(trace.decisionId).toBe("D-1001-ab12");
		expect(trace.chainDepth).toBe(1);
	});

	it("resume 中 G3 违规仍被拦截（src/main patch → escalated）", async () => {
		const { deps: d } = deps(
			resumeAgent({ result: fixedWithMr, writeSrcMain: true }),
		);
		const out = await runResumeRepair(d, event, {
			decisionId: "D-1001-ab12",
			...decision,
		});
		expect(out.kind).toBe("escalated");
		if (out.kind === "escalated") {
			expect(out.summary).toContain("G3");
			expect(out.decidable).toBeUndefined(); // 一轮介入：不再可决策
		}
	});

	it("resume 空 patch → escalated", async () => {
		const { deps: d } = deps(resumeAgent({ result: fixedWithMr }));
		const out = await runResumeRepair(d, event, {
			decisionId: "D-1001-ab12",
			...decision,
		});
		expect(out.kind).toBe("escalated");
		if (out.kind === "escalated") expect(out.summary).toContain("empty patch");
	});

	it("agent 再度 escalated → 透传 escalated（终局，绝不 decidable/保留）", async () => {
		const { deps: d, removeCalls } = deps(
			resumeAgent({
				result: {
					kind: "escalated",
					diagnosis: { failureClass: 3, summary: "二轮仍无解" },
					reason: "second escalation",
					source: "agent",
				},
			}),
		);
		const out = await runResumeRepair(d, event, {
			decisionId: "D-1001-ab12",
			...decision,
		});
		expect(out.kind).toBe("escalated");
		if (out.kind === "escalated") {
			expect(out.summary).toBe("second escalation");
			expect(out.decidable).toBeUndefined();
		}
		expect(removeCalls).toContain(cwd); // 不保留现场（manager 终局清理）
	});

	it("runner 不支持 resume → failed（fail loud）", async () => {
		const bare: AgentRunner = {
			run: async () => fixedWithMr,
			continue: async () => fixedWithMr,
			close: () => {},
		};
		const { deps: d } = deps(bare);
		const out = await runResumeRepair(d, event, {
			decisionId: "D-1001-ab12",
			...decision,
		});
		expect(out.kind).toBe("failed");
	});

	it("agent.resume 抛错 → failed（不 crash）", async () => {
		const agent = resumeAgent({ result: fixedWithMr });
		(agent as { resume: (i: unknown, d: unknown) => Promise<AgentResult> }).resume =
			async () => {
				throw new Error("session exploded");
			};
		const { deps: d } = deps(agent);
		const out = await runResumeRepair(d, event, {
			decisionId: "D-1001-ab12",
			...decision,
		});
		expect(out.kind).toBe("failed");
		if (out.kind === "failed") expect(out.summary).toContain("agent-resume");
	});

	it("resume 不创建 worktree（复用保留现场）", async () => {
		const { deps: d } = deps(
			resumeAgent({ result: fixedWithMr, writeTest: true }),
		);
		await runResumeRepair(d, event, { decisionId: "D-1001-ab12", ...decision });
		// create throws by construction; reaching here proves it was never called.
		expect(existsSync(repoCwd)).toBe(true);
	});
});

describe("runResumeRepair — widen 扩围（ADR-0009）", () => {
	let cwd: string;
	let repoCwd: string;

	beforeEach(() => {
		cwd = mkdtempSync(join(tmpdir(), "run-resume-widen-"));
		repoCwd = seedRetainedRepo(cwd);
	});
	afterEach(() => {
		rmSync(cwd, { recursive: true, force: true });
	});

	/** MR diff 只含 main 文件——resume 改动的测试文件在 diff 外。 */
	function glabMainOnlyDiff(): GitLabClient {
		return {
			fetchCiLog: async () => "test failure",
			fetchMrDiff: async () =>
				"diff --git a/src/main/java/com/example/Calculator.java b/src/main/java/com/example/Calculator.java",
			fetchMrPipelineStatus: async () => ({ status: "success", pipelineId: 999 }),
			createMr: async () => ({ url: "https://mr/x" }),
		};
	}

	function widenDeps(agent: AgentRunner) {
		const { worktree } = retainedWorktree(repoCwd);
		return {
			agent,
			glab: glabMainOnlyDiff(),
			dingtalk: new InMemoryDingTalkNotifier(),
			cwd,
			worktree,
		};
	}

	const TEST_FILE = "src/test/java/com/example/CalculatorTest.java";

	it("widen + 批准清单含该测试文件 → G3 放行，mr 终局", async () => {
		const out = await runResumeRepair(
			widenDeps(resumeAgent({ result: fixedWithMr, writeTest: true })),
			{ ...event, mrIid: 7 },
			{
				decisionId: "D-widen-1",
				value: "widen",
				remark: "",
				oosPaths: [TEST_FILE],
			},
		);
		expect(out.kind).toBe("mr");
	});

	it("同样 patch 但 test 决策（无扩围）→ G3 拦截转交", async () => {
		const out = await runResumeRepair(
			widenDeps(resumeAgent({ result: fixedWithMr, writeTest: true })),
			{ ...event, mrIid: 7 },
			{ decisionId: "D-test-1", value: "test", remark: "" },
		);
		expect(out.kind).toBe("escalated");
		expect(out.summary).toContain("G3/diff 违规");
	});
});
