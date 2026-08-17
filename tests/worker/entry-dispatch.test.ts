/**
 * Worker entry dispatch (T06): CIHEAL_WORKER_TASK mode "resume" routes to the
 * resume orchestration; absent mode keeps the repair path byte-identical.
 * In-process (env-driven) — the subprocess seam itself is covered by e2e.
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { execFileSync } from "node:child_process";
import {
	mkdirSync,
	mkdtempSync,
	readFileSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { main } from "../../src/worker/entry.js";
import type { PipelineEvent } from "../../src/types.js";

const event: PipelineEvent = {
	projectId: "42",
	pipelineId: 1001,
	ref: "main",
	sha: "abc1234567890",
	projectUrl: "https://git.example.com/g/p",
};

const ENV_KEYS = [
	"CIHEAL_WORKER_TASK",
	"CIHEAL_RESULT_FILE",
	"CIHEAL_AGENT_MODE",
	"CIHEAL_GLAB_MODE",
	"CIHEAL_DINGTALK_MODE",
	"CIHEAL_WORKTREE_MODE",
	"CIHEAL_STUB_MR_STATUS",
] as const;

function git(args: readonly string[], cwd: string): void {
	execFileSync("git", [...args], { cwd, stdio: "pipe" });
}

/** Seed a retained repo at <cwd>/repo so the resume worker finds its scene. */
function seedRetainedRepo(cwd: string): void {
	const repoCwd = join(cwd, "repo");
	mkdirSync(join(repoCwd, "src/test/java/com/example"), { recursive: true });
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
}

describe("worker entry dispatch（T06）", () => {
	let cwd: string;
	let saved: Record<string, string | undefined>;

	beforeEach(() => {
		cwd = mkdtempSync(join(tmpdir(), "entry-dispatch-"));
		saved = {};
		for (const key of ENV_KEYS) {
			saved[key] = process.env[key];
		}
		process.env.CIHEAL_AGENT_MODE = "stub";
		process.env.CIHEAL_GLAB_MODE = "fake";
		process.env.CIHEAL_DINGTALK_MODE = "fake";
		process.env.CIHEAL_WORKTREE_MODE = "fake";
		process.env.CIHEAL_RESULT_FILE = join(cwd, "result.json");
	});
	afterEach(() => {
		for (const key of ENV_KEYS) {
			if (saved[key] === undefined) delete process.env[key];
			else process.env[key] = saved[key];
		}
		rmSync(cwd, { recursive: true, force: true });
	});

	it("mode=resume → 走 resume 编排，复用保留现场产出 MR", async () => {
		seedRetainedRepo(cwd);
		process.env.CIHEAL_WORKER_TASK = JSON.stringify({
			mode: "resume",
			event,
			cwd,
			decision: { decisionId: "D-1001-ab12", value: "test", remark: "应为 5" },
		});

		await main();

		const result = JSON.parse(
			readFileSync(join(cwd, "result.json"), "utf8"),
		);
		expect(result.kind).toBe("mr");
		// Audit carries the decision chain.
		const trace = JSON.parse(
			readFileSync(join(cwd, "audit-trace.json"), "utf8"),
		);
		expect(trace.decisionId).toBe("D-1001-ab12");
		expect(trace.chainDepth).toBe(1);
	});

	it("无 mode（repair 信封）→ 原 repair 路径不变", async () => {
		process.env.CIHEAL_WORKER_TASK = JSON.stringify({ event, cwd });

		await main();

		const result = JSON.parse(
			readFileSync(join(cwd, "result.json"), "utf8"),
		);
		expect(result.kind).toBe("mr"); // stub agent canned fix → MR
	});
});
