/**
 * Graceful shutdown (deploy/restart resilience): SIGTERM must terminate
 * running workers AND clean their scenes, so a container restart leaves no
 * worktree residue blocking the next pipeline of the same MR
 * (dev incident: pipelines 100034153 → 100034231/100034233).
 */
import { afterEach, describe, expect, it } from "vitest";
import {
	existsSync,
	mkdtempSync,
	readFileSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SubprocessWorkerManager } from "../../src/worker/manager.js";
import type { PipelineEvent } from "../../src/types.js";

const event: PipelineEvent = {
	projectId: "shutdown-sig",
	pipelineId: 601,
	ref: "main",
	sha: "shut0000000000",
	projectUrl: "https://git.example.com/shutdown/sig",
};

const tmpDirs: string[] = [];

afterEach(() => {
	for (const dir of tmpDirs.splice(0)) {
		rmSync(dir, { recursive: true, force: true });
	}
});

/** Probe: signals readiness, then stays alive until killed. */
function makeSleepProbe(): string {
	const dir = mkdtempSync(join(tmpdir(), "shutdown-probe-"));
	tmpDirs.push(dir);
	const script = join(dir, "probe.mjs");
	writeFileSync(
		script,
		[
			'import { writeFileSync } from "node:fs";',
			"const resultFile = process.env.CIHEAL_RESULT_FILE;",
			"writeFileSync(`${resultFile}.ready`, '1');",
			// Stay alive far longer than the test; only a kill ends it.
			"setTimeout(() => process.exit(0), 60_000);",
		].join("\n"),
		"utf8",
	);
	return script;
}

function waitForReady(cwd: string, timeoutMs = 5000): Promise<void> {
	const ready = join(cwd, "result.json.ready");
	const start = Date.now();
	return new Promise((resolve, reject) => {
		const tick = () => {
			try {
				readFileSync(ready, "utf8");
				resolve();
			} catch {
				if (Date.now() - start > timeoutMs) {
					reject(new Error("probe never became ready"));
					return;
				}
				setTimeout(tick, 30);
			}
		};
		tick();
	});
}

describe("SubprocessWorkerManager.shutdown", () => {
	it("terminates running workers and cleans their scenes", async () => {
		const manager = new SubprocessWorkerManager({
			nodeBin: process.execPath,
			entryScript: makeSleepProbe(),
		});
		const cwd = mkdtempSync(join(tmpdir(), "shutdown-work-"));
		tmpDirs.push(cwd);

		const runPromise = manager.run(event, cwd);
		await waitForReady(cwd);

		// Attach the rejection expectation BEFORE the kill: the run promise
		// rejects mid-shutdown, and a handler attached only afterwards would
		// leave an unhandled-rejection window across the drain's macrotasks.
		const rejected = expect(runPromise).rejects.toThrow();

		await manager.shutdown();

		// The killed worker surfaces as a failed run, and its scene is gone
		// by the time shutdown resolves (no worktree residue for the next run).
		await rejected;
		expect(existsSync(cwd)).toBe(false);
	});

	it("resolves when no workers are active", async () => {
		const manager = new SubprocessWorkerManager({});
		await expect(manager.shutdown()).resolves.toBeUndefined();
	});
});
