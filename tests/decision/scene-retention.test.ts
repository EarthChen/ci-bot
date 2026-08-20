import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DecisionStore } from "../../src/decision/store.js";
import { Scheduler } from "../../src/agent-runtime/scheduler.js";
import { CI_REPAIR_SCHEDULING_POLICY } from "../../src/agent/ci-repair-definition.js";
import { SubprocessWorkerManager } from "../../src/worker/manager.js";
import type { PipelineEvent, RepairOutcome } from "../../src/types.js";

const event: PipelineEvent = {
	projectId: "proj-integrate",
	pipelineId: 601,
	ref: "main",
	sha: "fedcba9876543210",
	projectUrl: "https://git.example.com/g/p",
};

/** Minimal canned-outcome entry (same seam as tests/worker/scene-retention). */
function writeCannedEntry(dir: string, _outcome: RepairOutcome): string {
	const entry = join(dir, "canned-entry.mjs");
	writeFileSync(
		entry,
		[
			'import { mkdirSync, writeFileSync } from "node:fs";',
			'import { dirname } from "node:path";',
			"const resultFile = process.env.CIHEAL_RESULT_FILE;",
			"mkdirSync(dirname(resultFile), { recursive: true });",
			'writeFileSync(resultFile, process.env.CIHEAL_STUB_OUTCOME ?? "{}");',
		].join("\n"),
		"utf8",
	);
	return entry;
}

describe("现场保留 + 决策注册（主进程集成）", () => {
	let dataDir: string;
	let store: DecisionStore;

	beforeEach(() => {
		dataDir = mkdtempSync(join(tmpdir(), "scene-integrate-"));
		store = new DecisionStore(join(dataDir, "decisions.db"));
	});

	afterEach(() => {
		store.close();
		rmSync(dataDir, { recursive: true, force: true });
	});

	it("decidable escalated：scheduler 注册决策 + manager 保留 cwd", async () => {
		const workRoot = join(dataDir, "work");
		const outcome: RepairOutcome = {
			kind: "escalated",
			summary: "need human decision",
			decidable: true,
			diagnosisSummary: "spec unreadable",
		};
		const manager = new SubprocessWorkerManager({
			entryScript: writeCannedEntry(dataDir, outcome),
			timeoutMs: 30_000,
			env: { CIHEAL_STUB_OUTCOME: JSON.stringify(outcome) },
		});
		const scheduler = new Scheduler({
			workerManager: manager,
			workRoot,
			policy: CI_REPAIR_SCHEDULING_POLICY,
			maxWorkers: 1,
			decisionStore: store,
		});

		scheduler.enqueue(event);
		await scheduler.idle();

		const records = store.listByStatus("awaiting_decision");
		expect(records).toHaveLength(1);
		const record = records[0];
		expect(record.decision_id).toMatch(/^D-601-[0-9a-f]{4}$/);
		expect(record.project_id).toBe("proj-integrate");
		expect(record.pipeline_id).toBe("601");
		expect(record.branch).toBe("ci-self-heal/main-fedcba98");
		expect(record.session_path).toBe(join(record.cwd_path, ".pi-agent"));
		expect(JSON.parse(record.event_json).projectId).toBe("proj-integrate");
		expect(new Date(record.expires_at).getTime()).toBeGreaterThan(Date.now());
		// 现场确实保留在磁盘上
		expect(existsSync(record.cwd_path)).toBe(true);
		expect(existsSync(join(record.cwd_path, "result.json"))).toBe(true);
	});

	it("非 decidable escalated：不注册决策，cwd 被清理", async () => {
		const workRoot = join(dataDir, "work");
		const outcome: RepairOutcome = { kind: "escalated", summary: "budget" };
		const manager = new SubprocessWorkerManager({
			entryScript: writeCannedEntry(dataDir, outcome),
			timeoutMs: 30_000,
			env: { CIHEAL_STUB_OUTCOME: JSON.stringify(outcome) },
		});
		const scheduler = new Scheduler({
			workerManager: manager,
			workRoot,
			policy: CI_REPAIR_SCHEDULING_POLICY,
			maxWorkers: 1,
			decisionStore: store,
		});

		scheduler.enqueue({ ...event, pipelineId: 602 });
		await scheduler.idle();

		expect(store.listByStatus("awaiting_decision")).toEqual([]);
	});
});
