/**
 * E2E resume test (T06): envelope → real subprocess worker → retained scene →
 * MR sidecar. The agent is the stub runner's canned resume fix; glab/dingtalk
 * are fakes persisting sidecars. Everything else is real: manager.runResume,
 * entry mode dispatch, session-less stub orchestration, extractPatch → G3 →
 * MR monitor, audit trace with decision chain.
 */
import { describe, it, expect, afterEach } from "vitest";
import { readFile, rm } from "node:fs/promises";
import { existsSync } from "node:fs";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SubprocessWorkerManager } from "../../src/worker/manager.js";
import { defaultWorktree } from "../../src/pipeline/worktree.js";
import type { ResumeTask } from "../../src/agent-runtime/scheduler.js";
import type { PipelineEvent } from "../../src/types.js";

const event: PipelineEvent = {
	projectId: "proj-resume-e2e",
	pipelineId: 9001,
	ref: "main",
	sha: "abc1234567890",
	projectUrl: "https://git.example.com/proj-resume-e2e",
};

describe("e2e resume — 保留现场 → subprocess worker → MR", () => {
	const tempDirs: string[] = [];

	afterEach(async () => {
		for (const dir of tempDirs.splice(0)) {
			await rm(dir, { recursive: true, force: true }).catch(() => {});
		}
	});

	/** Seed a retained scene: fake worktree creates <cwd>/repo with sha tag. */
	async function seedRetainedScene(): Promise<string> {
		const dir = await mkdtemp(join(tmpdir(), "resume-e2e-"));
		tempDirs.push(dir);
		const cwd = join(dir, "work-9001");
		const saved = process.env.CIHEAL_WORKTREE_MODE;
		process.env.CIHEAL_WORKTREE_MODE = "fake";
		try {
			await defaultWorktree.create(cwd, event);
		} finally {
			if (saved === undefined) delete process.env.CIHEAL_WORKTREE_MODE;
			else process.env.CIHEAL_WORKTREE_MODE = saved;
		}
		return cwd;
	}

	function makeManager(extraEnv: Record<string, string> = {}) {
		return new SubprocessWorkerManager({
			timeoutMs: 60_000,
			keepWork: true, // keep cwd so the test can read sidecars
			env: {
				CIHEAL_AGENT_MODE: "stub",
				CIHEAL_GLAB_MODE: "fake",
				CIHEAL_DINGTALK_MODE: "fake",
				CIHEAL_WORKTREE_MODE: "fake",
				...extraEnv,
			},
		});
	}

	function makeResumeTask(cwd: string): ResumeTask {
		return {
			mode: "resume",
			event,
			cwd,
			decision: {
				decisionId: "D-9001-ab12",
				value: "test",
				remark: "spec 规定 add(2,3) 应返回 5",
			},
		};
	}

	it("resume 修复链路端到端：envelope → worker → MR + 决策审计", async () => {
		const cwd = await seedRetainedScene();
		const manager = makeManager();
		const outcome = await manager.runResume(makeResumeTask(cwd));

		expect(outcome.kind).toBe("mr");
		if (outcome.kind === "mr") {
			// The stub agent's canned MR url survives the monitor loop.
			expect(outcome.mrUrl).toContain("merge_requests");
		}

		// Audit carries the decision chain.
		const trace = JSON.parse(
			await readFile(join(cwd, "audit-trace.json"), "utf8"),
		);
		expect(trace.decisionId).toBe("D-9001-ab12");
		expect(trace.chainDepth).toBe(1);
		expect(trace.outcome).toBe("mr");
		// The authoritative patch (git diff) touched ONLY test files (G3).
		expect(trace.diff).toContain("src/test");
		expect(trace.diff).not.toContain("src/main");
	}, 90_000);

	it("resume 中 G3 违规（stub 改 src/main）→ escalated，无 MR", async () => {
		const cwd = await seedRetainedScene();
		const manager = makeManager({ CIHEAL_STUB_FIX_KIND: "src-main" });
		const outcome = await manager.runResume(makeResumeTask(cwd));

		expect(outcome.kind).toBe("escalated");
		if (outcome.kind === "escalated") {
			expect(outcome.summary).toContain("G3");
			expect(outcome.decidable).toBeUndefined(); // 一轮介入终局
		}
		expect(existsSync(join(cwd, "glab-mr-creates.json"))).toBe(false);
	}, 90_000);
});
