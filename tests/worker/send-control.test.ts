/**
 * Ticket 05: main→worker control channel via reverse IPC.
 * Cross-process observation via probe sidecars (cf. ipc-env.test.ts).
 */
import { afterEach, describe, expect, it } from "vitest";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SubprocessWorkerManager } from "../../src/worker/manager.js";
import type { PipelineEvent } from "../../src/types.js";

const event: PipelineEvent = {
	projectId: "ctrl-send",
	pipelineId: 501,
	ref: "main",
	sha: "ctrl0000000000",
	projectUrl: "https://git.example.com/ctrl/send",
};

const tmpDirs: string[] = [];

afterEach(() => {
	for (const dir of tmpDirs.splice(0)) {
		rmSync(dir, { recursive: true, force: true });
	}
});

/** Probe: stays alive until parent sends control or timeout, then exits. */
function makeControlProbe(): string {
	const dir = mkdtempSync(join(tmpdir(), "ctrl-probe-"));
	tmpDirs.push(dir);
	const script = join(dir, "probe.mjs");
	writeFileSync(
		script,
		[
			'import { writeFileSync } from "node:fs";',
			"const resultFile = process.env.CIHEAL_RESULT_FILE;",
			"let finished = false;",
			"function finish() {",
			"	if (finished) return;",
			"	finished = true;",
			"	clearTimeout(timer);",
			"	writeFileSync(resultFile, JSON.stringify({ kind: 'failed', summary: 'probe' }));",
			"	process.exit(0);",
			"}",
			"process.on('message', (msg) => {",
			"	writeFileSync(`${resultFile}.control`, JSON.stringify(msg));",
			"	if (typeof process.send === 'function') {",
			"		process.send({ type: 'control_ack', controlType: msg.type });",
			"	}",
			"	finish();",
			"});",
			"writeFileSync(`${resultFile}.ready`, '1');",
			"const timer = setTimeout(finish, 3000);",
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
				return;
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

describe("SubprocessWorkerManager.sendControl", () => {
	it("向运行中 worker 发送控制消息 → 返回 true", async () => {
		const cwd = mkdtempSync(join(tmpdir(), "ctrl-running-"));
		tmpDirs.push(cwd);
		const received: unknown[] = [];
		const manager = new SubprocessWorkerManager({
			keepWork: true,
			nodeBin: process.execPath,
			entryScript: makeControlProbe(),
			onIpcMessage: (_event, msg) => received.push(msg),
		});

		const runPromise = manager.run(event, cwd);
		await waitForReady(cwd);

		const msg = { type: "supersede" as const, payload: { reason: "test" } };
		expect(manager.sendControl!(event, msg)).toBe(true);

		await runPromise;

		expect(JSON.parse(readFileSync(join(cwd, "result.json.control"), "utf8"))).toEqual(msg);
		expect(received).toContainEqual({ type: "control_ack", controlType: "supersede" });
	});

	it("向已结束 worker 发送控制消息 → 返回 false 且不抛异常", async () => {
		const endedEvent: PipelineEvent = { ...event, pipelineId: 502 };
		const cwd = mkdtempSync(join(tmpdir(), "ctrl-ended-"));
		tmpDirs.push(cwd);
		const manager = new SubprocessWorkerManager({
			keepWork: true,
			nodeBin: process.execPath,
			entryScript: makeControlProbe(),
			onIpcMessage: () => {},
		});

		await manager.run(endedEvent, cwd);

		expect(() =>
			manager.sendControl!(endedEvent, { type: "supersede", payload: null }),
		).not.toThrow();
		expect(manager.sendControl!(endedEvent, { type: "supersede", payload: null })).toBe(false);
	});
});
