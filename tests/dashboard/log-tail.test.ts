import { mkdirSync, mkdtempSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
	readSessionActivityTail,
	readWorkerLogTail,
} from "../../src/dashboard/log-tail.js";

describe("readWorkerLogTail", () => {
	it("parses pino JSONL lines from the newest *-worker-log dir", () => {
		const auditDir = mkdtempSync(join(tmpdir(), "audit-"));
		const oldDir = join(auditDir, "42", "aaa-worker-log");
		const newDir = join(auditDir, "42", "bbb-worker-log");
		mkdirSync(oldDir, { recursive: true });
		mkdirSync(newDir, { recursive: true });
		writeFileSync(
			join(oldDir, "worker.log"),
			JSON.stringify({ time: "2026-08-20T03:00:00.000Z", level: 30, msg: "stale run" }) + "\n",
		);
		writeFileSync(
			join(newDir, "worker.log"),
			[
				JSON.stringify({ time: "2026-08-20T04:00:00.000Z", level: 30, msg: "runRepair start" }),
				JSON.stringify({ time: "2026-08-20T04:00:01.000Z", level: 50, msg: "boom", err: { message: "x" } }),
				"not-json-line",
			].join("\n") + "\n",
		);
		// Explicit, well-separated mtimes ON THE LOG FILES (the impl sorts by
		// file mtime). Relying on write-order granularity is filesystem-dependent:
		// tied mtimes degrade the sort to readdir order — that race failed CI.
		const nowSec = Math.floor(Date.now() / 1000);
		utimesSync(join(oldDir, "worker.log"), nowSec - 3600, nowSec - 3600);
		utimesSync(join(newDir, "worker.log"), nowSec, nowSec);

		const lines = readWorkerLogTail(auditDir, "42");

		expect(lines).toEqual([
			{ time: "2026-08-20T04:00:00.000Z", level: "info", msg: "runRepair start" },
			{ time: "2026-08-20T04:00:01.000Z", level: "error", msg: "boom" },
		]);
	});

	it("returns only the last maxLines lines", () => {
		const auditDir = mkdtempSync(join(tmpdir(), "audit-"));
		const dir = join(auditDir, "7", "x-worker-log");
		mkdirSync(dir, { recursive: true });
		const rows: string[] = [];
		for (let i = 0; i < 300; i++) {
			rows.push(JSON.stringify({ time: `t${i}`, level: 30, msg: `line-${i}` }));
		}
		writeFileSync(join(dir, "worker.log"), rows.join("\n") + "\n");

		const lines = readWorkerLogTail(auditDir, "7", 200);

		expect(lines).toHaveLength(200);
		expect(lines[0]?.msg).toBe("line-100");
		expect(lines[199]?.msg).toBe("line-299");
	});

	it("returns [] when the pipeline has no worker-log dir", () => {
		const auditDir = mkdtempSync(join(tmpdir(), "audit-"));
		expect(readWorkerLogTail(auditDir, "999")).toEqual([]);
	});
});

describe("readSessionActivityTail", () => {
	function makeSessionDir(cwd: string, jsonl: string): void {
		const dir = join(cwd, ".pi-agent", "sessions", "--some-worktree--");
		mkdirSync(dir, { recursive: true });
		writeFileSync(join(dir, "2026-08-20T03-00-00-000Z_abc.jsonl"), jsonl);
	}

	it("maps assistant text / toolCall / toolResult into activity items, skipping thinking", () => {
		const cwd = mkdtempSync(join(tmpdir(), "work-"));
		makeSessionDir(cwd, [
			JSON.stringify({ type: "session", version: 3, id: "s1", timestamp: "t", cwd }),
			JSON.stringify({
				type: "message",
				id: "m1",
				timestamp: "2026-08-20T04:00:00.000Z",
				message: {
					role: "assistant",
					content: [
						{ type: "thinking", thinking: "private reasoning" },
						{ type: "text", text: "开始分析 CI 日志" },
						{ type: "toolCall", id: "c1", name: "read", arguments: { path: "ci-log.txt" } },
					],
				},
			}),
			JSON.stringify({
				type: "message",
				id: "m2",
				timestamp: "2026-08-20T04:00:05.000Z",
				message: {
					role: "toolResult",
					toolCallId: "c1",
					toolName: "read",
					content: [{ type: "text", text: "FAILED: CalculatorTest" }],
				},
			}),
		].join("\n") + "\n");

		const items = readSessionActivityTail(cwd);

		expect(items).toEqual([
			{ timestamp: "2026-08-20T04:00:00.000Z", kind: "text", summary: "开始分析 CI 日志" },
			{ timestamp: "2026-08-20T04:00:00.000Z", kind: "tool_call", summary: "read ci-log.txt" },
			{ timestamp: "2026-08-20T04:00:05.000Z", kind: "tool_result", summary: "read: FAILED: CalculatorTest" },
		]);
	});

	it("truncates long summaries", () => {
		const cwd = mkdtempSync(join(tmpdir(), "work-"));
		makeSessionDir(cwd, [
			JSON.stringify({
				type: "message",
				id: "m1",
				timestamp: "t1",
				message: { role: "assistant", content: [{ type: "text", text: "x".repeat(5000) }] },
			}),
		].join("\n") + "\n");

		const items = readSessionActivityTail(cwd);

		expect(items).toHaveLength(1);
		expect(items[0]!.summary.length).toBeLessThanOrEqual(303); // 300 + "..."
	});

	it("returns only the last maxItems items", () => {
		const cwd = mkdtempSync(join(tmpdir(), "work-"));
		const rows: string[] = [];
		for (let i = 0; i < 100; i++) {
			rows.push(JSON.stringify({
				type: "message",
				id: `m${i}`,
				timestamp: `t${i}`,
				message: { role: "assistant", content: [{ type: "text", text: `msg-${i}` }] },
			}));
		}
		makeSessionDir(cwd, rows.join("\n") + "\n");

		const items = readSessionActivityTail(cwd, 20);

		expect(items).toHaveLength(20);
		expect(items[0]?.summary).toBe("msg-80");
		expect(items[19]?.summary).toBe("msg-99");
	});

	it("returns [] when cwd has no session files", () => {
		const cwd = mkdtempSync(join(tmpdir(), "work-"));
		expect(readSessionActivityTail(cwd)).toEqual([]);
	});
});
