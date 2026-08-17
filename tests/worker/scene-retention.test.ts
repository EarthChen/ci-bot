import { describe, expect, it } from "vitest";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SubprocessWorkerManager } from "../../src/worker/manager.js";
import type { RepairOutcome } from "../../src/types.js";

const event = {
	projectId: "proj-retain",
	pipelineId: 501,
	ref: "main",
	sha: "abcdef1234567890",
	projectUrl: "https://git.example.com/g/p",
};

/**
 * Minimal worker entry: writes the canned outcome from CIHEAL_STUB_OUTCOME
 * straight into CIHEAL_RESULT_FILE and exits 0. This isolates the manager's
 * cleanup decision (retain vs remove) from the pipeline internals.
 */
function writeCannedEntry(dir: string): string {
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

function makeManager(entryScript: string, outcome: RepairOutcome) {
	return new SubprocessWorkerManager({
		entryScript,
		timeoutMs: 30_000,
		env: { CIHEAL_STUB_OUTCOME: JSON.stringify(outcome) },
	});
}

describe("SubprocessWorkerManager — 现场保留（decidable escalated）", () => {
	it("decidable escalated → 保留 cwd（跳过清理）", async () => {
		const dir = mkdtempSync(join(tmpdir(), "scene-retain-"));
		const cwd = join(dir, "work-501");
		try {
			const manager = makeManager(writeCannedEntry(dir), {
				kind: "escalated",
				summary: "need human decision",
				decidable: true,
				diagnosisSummary: "spec unreadable",
			});
			const out = await manager.run(event, cwd);
			expect(out.kind).toBe("escalated");
			expect(existsSync(cwd)).toBe(true);
			expect(existsSync(join(cwd, "result.json"))).toBe(true);
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});

	it("非 decidable escalated → 清理 cwd（行为不变）", async () => {
		const dir = mkdtempSync(join(tmpdir(), "scene-remove-"));
		const cwd = join(dir, "work-502");
		try {
			const manager = makeManager(writeCannedEntry(dir), {
				kind: "escalated",
				summary: "budget exceeded",
			});
			await manager.run({ ...event, pipelineId: 502 }, cwd);
			expect(existsSync(cwd)).toBe(false);
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});

	it("mr outcome → 清理 cwd（行为不变）", async () => {
		const dir = mkdtempSync(join(tmpdir(), "scene-mr-"));
		const cwd = join(dir, "work-503");
		try {
			const manager = makeManager(writeCannedEntry(dir), {
				kind: "mr",
				mrUrl: "https://mr/1",
				summary: "fixed",
			});
			await manager.run({ ...event, pipelineId: 503 }, cwd);
			expect(existsSync(cwd)).toBe(false);
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});

	it("keepWork 语义不变：即便 decidable 也由 keepWork 决定保留", async () => {
		const dir = mkdtempSync(join(tmpdir(), "scene-keepwork-"));
		const cwd = join(dir, "work-504");
		try {
			const manager = new SubprocessWorkerManager({
				entryScript: writeCannedEntry(dir),
				timeoutMs: 30_000,
				keepWork: true,
				env: {
					CIHEAL_STUB_OUTCOME: JSON.stringify({
						kind: "escalated",
						summary: "x",
					}),
				},
			});
			await manager.run({ ...event, pipelineId: 504 }, cwd);
			expect(existsSync(cwd)).toBe(true);
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});
});
