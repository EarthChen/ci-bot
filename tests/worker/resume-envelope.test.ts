import { describe, expect, it } from "vitest";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SubprocessWorkerManager } from "../../src/worker/manager.js";
import type { ResumeTask } from "../../src/agent-runtime/scheduler.js";
import type { RepairOutcome } from "../../src/types.js";

const event = {
	projectId: "proj-resume",
	pipelineId: 701,
	ref: "main",
	sha: "abcdef1234567890",
	projectUrl: "https://git.example.com/g/p",
};

/**
 * Canned entry: writes the CIHEAL_WORKER_TASK envelope to task-dump.json (for
 * the parent test to inspect) and a canned outcome into CIHEAL_RESULT_FILE.
 */
function writeCannedEntry(dir: string, outcome: RepairOutcome): string {
	const entry = join(dir, "canned-entry.mjs");
	writeFileSync(
		entry,
		[
			'import { mkdirSync, writeFileSync } from "node:fs";',
			'import { dirname, join } from "node:path";',
			"const resultFile = process.env.CIHEAL_RESULT_FILE;",
			"mkdirSync(dirname(resultFile), { recursive: true });",
			`writeFileSync(resultFile, ${JSON.stringify(JSON.stringify(outcome))});`,
			'writeFileSync(join(dirname(resultFile), "task-dump.json"), process.env.CIHEAL_WORKER_TASK ?? "");',
		].join("\n"),
		"utf8",
	);
	return entry;
}

function makeResumeTask(cwd: string): ResumeTask {
	return {
		mode: "resume",
		event,
		cwd,
		decision: {
			decisionId: "D-701-ab12",
			value: "test",
			remark: "spec says five",
		},
	};
}

describe("SubprocessWorkerManager.runResume — resume 信封契约（T05）", () => {
	it("worker 收到的 CIHEAL_WORKER_TASK 即 resume 信封（mode/event/cwd/decision）", async () => {
		const dir = mkdtempSync(join(tmpdir(), "resume-envelope-"));
		const cwd = join(dir, "work-701");
		try {
			const manager = new SubprocessWorkerManager({
				entryScript: writeCannedEntry(dir, {
					kind: "escalated",
					summary: "terminal",
				}),
				timeoutMs: 30_000,
				keepWork: true, // keep the dump file readable after the run
			});
			const task = makeResumeTask(cwd);
			await manager.runResume(task);

			const dump = JSON.parse(readFileSync(join(cwd, "task-dump.json"), "utf8"));
			expect(dump).toEqual(task);
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});

	it("resume 完成后现场总是清理（一轮介入终局，不因 decidable outcome 再保留）", async () => {
		const dir = mkdtempSync(join(tmpdir(), "resume-terminal-"));
		const cwd = join(dir, "work-702");
		try {
			const manager = new SubprocessWorkerManager({
				entryScript: writeCannedEntry(dir, {
					// An outcome that would normally trigger scene retention —
					// after a resume it must NOT re-retain (one-round limit).
					kind: "escalated",
					summary: "second escalation",
					decidable: true,
				}),
				timeoutMs: 30_000,
			});
			await manager.runResume(makeResumeTask(cwd));
			expect(existsSync(cwd)).toBe(false);
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});
});
