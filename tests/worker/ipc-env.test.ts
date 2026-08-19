import { afterEach, describe, expect, it } from "vitest";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SubprocessWorkerManager } from "../../src/worker/manager.js";
import type { PipelineEvent } from "../../src/types.js";

/**
 * CIHEAL_WORKER_IPC env contract: the manager injects the flag exactly when
 * it wires the worker's IPC channel (onIpcMessage → stdio "ipc"). sendIpc
 * gates on this flag instead of process.send presence — vitest forks pool
 * workers also expose process.send (tinypool's own channel), and sending our
 * envelope there breaks its protocol (OOM'd tests/worker/entry-dispatch).
 *
 * The probe child reports its own view (flag + channel) via a sidecar file —
 * the standard cross-process observation pattern (cf. glab-mr-creates.json).
 */

const event: PipelineEvent = {
	projectId: "ipc-env",
	pipelineId: 777,
	ref: "main",
	sha: "ipc0000000000",
	projectUrl: "https://git.example.com/ipc/env",
};

const tmpDirs: string[] = [];

afterEach(() => {
	for (const dir of tmpDirs.splice(0)) {
		rmSync(dir, { recursive: true, force: true });
	}
});

/** Probe entry: writes outcome + its IPC view, then sends one IPC message if a channel exists. */
function makeProbe(): string {
	const dir = mkdtempSync(join(tmpdir(), "ipc-env-probe-"));
	tmpDirs.push(dir);
	const script = join(dir, "probe.mjs");
	writeFileSync(
		script,
		[
			'import { writeFileSync } from "node:fs";',
			'writeFileSync(process.env.CIHEAL_RESULT_FILE, JSON.stringify({ kind: "failed", summary: "probe" }));',
			"writeFileSync(",
			'	`${process.env.CIHEAL_RESULT_FILE}.ipc`,',
			"	JSON.stringify({",
			'		flag: process.env.CIHEAL_WORKER_IPC ?? null,',
			'		hasSend: typeof process.send === "function",',
			"	}),",
			");",
			'if (typeof process.send === "function") {',
			'	process.send({ type: "stage_exit", stage: "probe" });',
			"	// give the parent a beat to receive before exit",
			"	await new Promise((r) => setTimeout(r, 100));",
			"}",
		].join("\n"),
		"utf8",
	);
	return script;
}

function readProbeState(cwd: string): { flag: string | null; hasSend: boolean } {
	return JSON.parse(readFileSync(join(cwd, "result.json.ipc"), "utf8"));
}

describe("CIHEAL_WORKER_IPC 注入契约", () => {
	it("onIpcMessage 接线 → 注入标志且子进程有 IPC 通道，消息到达父进程", async () => {
		const cwd = mkdtempSync(join(tmpdir(), "ipc-env-wired-"));
		tmpDirs.push(cwd);
		const received: unknown[] = [];
		const manager = new SubprocessWorkerManager({
			keepWork: true,
			nodeBin: process.execPath,
			entryScript: makeProbe(),
			onIpcMessage: (_event, msg) => received.push(msg),
		});

		await manager.run(event, cwd);

		expect(readProbeState(cwd)).toEqual({ flag: "1", hasSend: true });
		expect(received).toEqual([{ type: "stage_exit", stage: "probe" }]);
	});

	it("未接 onIpcMessage → 不注入标志且子进程无 IPC 通道", async () => {
		const cwd = mkdtempSync(join(tmpdir(), "ipc-env-unwired-"));
		tmpDirs.push(cwd);
		const manager = new SubprocessWorkerManager({
			keepWork: true,
			nodeBin: process.execPath,
			entryScript: makeProbe(),
		});

		await manager.run(event, cwd);

		expect(readProbeState(cwd)).toEqual({ flag: null, hasSend: false });
	});
});
