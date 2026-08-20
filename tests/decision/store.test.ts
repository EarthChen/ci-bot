import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Database from "better-sqlite3";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { DecisionStore } from "../../src/decision/store.js";
import type { DecisionRecord, DecisionStatus } from "../../src/decision/store.js";
import { sanitizeDecision } from "../../src/dashboard/routes.js";
import type { DecisionSummary } from "../../src/dashboard/shared-types.js";

function makeEvent(projectId = "proj-1", pipelineId = "pipe-1", mrIid?: number) {
	return { projectId, pipelineId, sha: "abc123", ref: "main", ...(mrIid !== undefined ? { mrIid } : {}) };
}

function makeCreateParams(overrides: Partial<DecisionRecord> = {}): Omit<
	DecisionRecord,
	"status" | "created_at" | "expires_at" | "decided_by" | "decision_value" | "remark" | "decided_at" | "oos_paths"
> & { status?: DecisionStatus; expires_at: string } {
	const expiresAt = new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString();
	return {
		decision_id: overrides.decision_id ?? "D-pipe-1-a1b2",
		pipeline_id: overrides.pipeline_id ?? "pipe-1",
		project_id: overrides.project_id ?? "proj-1",
		event_json: overrides.event_json ?? JSON.stringify(makeEvent()),
		cwd_path: overrides.cwd_path ?? "/tmp/work/uuid-1",
		session_path: overrides.session_path ?? "/tmp/work/uuid-1/.pi-agent/session.jsonl",
		branch: overrides.branch ?? "ci-self-heal/main-abc12345",
		status: overrides.status ?? "awaiting_decision",
		expires_at: overrides.expires_at ?? expiresAt,
	};
}

describe("DecisionStore", () => {
	let dir: string;
	let store: DecisionStore;

	beforeEach(() => {
		dir = mkdtempSync(join(tmpdir(), "decision-store-"));
		store = new DecisionStore(join(dir, "decisions.db"));
	});

	afterEach(() => {
		store.close();
		rmSync(dir, { recursive: true, force: true });
	});

	describe("create + get", () => {
		it("creates a decision and retrieves it by id", () => {
			const params = makeCreateParams();
			store.create(params);

			const record = store.get("D-pipe-1-a1b2");
			expect(record).toBeDefined();
			expect(record!.decision_id).toBe("D-pipe-1-a1b2");
			expect(record!.pipeline_id).toBe("pipe-1");
			expect(record!.project_id).toBe("proj-1");
			expect(record!.status).toBe("awaiting_decision");
			expect(record!.cwd_path).toBe("/tmp/work/uuid-1");
			expect(record!.session_path).toBe("/tmp/work/uuid-1/.pi-agent/session.jsonl");
			expect(record!.branch).toBe("ci-self-heal/main-abc12345");
			expect(record!.decided_by).toBeNull();
			expect(record!.decision_value).toBeNull();
			expect(record!.remark).toBeNull();
			expect(record!.decided_at).toBeNull();
			expect(record!.created_at).toBeTruthy();
			expect(record!.expires_at).toBeTruthy();
		});

		it("returns undefined for non-existent id", () => {
			expect(store.get("nonexistent")).toBeUndefined();
		});

		it("rejects duplicate decision_id", () => {
			const params = makeCreateParams();
			store.create(params);
			expect(() => store.create(params)).toThrow();
		});
	});

	describe("updateStatus", () => {
		it("updates status and decision fields", () => {
			store.create(makeCreateParams());

			store.updateStatus("D-pipe-1-a1b2", {
				status: "resumed",
				decided_by: "alice",
				decision_value: "test",
				remark: "spec says X should be Y",
			});

			const record = store.get("D-pipe-1-a1b2");
			expect(record!.status).toBe("resumed");
			expect(record!.decided_by).toBe("alice");
			expect(record!.decision_value).toBe("test");
			expect(record!.remark).toBe("spec says X should be Y");
			expect(record!.decided_at).toBeTruthy();
		});

		it("updates status without optional fields", () => {
			store.create(makeCreateParams());

			store.updateStatus("D-pipe-1-a1b2", { status: "expired" });

			const record = store.get("D-pipe-1-a1b2");
			expect(record!.status).toBe("expired");
			expect(record!.decided_by).toBeNull();
			expect(record!.decision_value).toBeNull();
			expect(record!.decided_at).toBeTruthy();
		});

		it("throws on non-existent id", () => {
			expect(() =>
				store.updateStatus("nonexistent", { status: "closed" }),
			).toThrow(/not found/i);
		});
	});

	describe("onChange callback", () => {
		it("fires create action after create()", () => {
			const changes: Array<{ action: string; decisionId: string }> = [];
			store.setOnChange((action, record) => {
				changes.push({ action, decisionId: record.decision_id });
			});
			store.create(makeCreateParams({ decision_id: "D-onchange-1" }));
			expect(changes).toEqual([{ action: "create", decisionId: "D-onchange-1" }]);
		});

		it("fires update action after updateStatus()", () => {
			store.create(makeCreateParams({ decision_id: "D-onchange-2" }));
			const changes: Array<{ action: string; status: string }> = [];
			store.setOnChange((action, record) => {
				changes.push({ action, status: record.status });
			});
			store.updateStatus("D-onchange-2", {
				status: "resumed",
				decided_by: "alice",
				decision_value: "test",
			});
			expect(changes).toEqual([{ action: "update", status: "resumed" }]);
		});

		it("update → decision_resolved SSE event when wired like main.ts", () => {
			store.create(makeCreateParams({ decision_id: "D-sse-2" }));
			const emitted: Array<{ type: string; data: DecisionSummary }> = [];
			const hub = {
				emit: (event: { type: string; data: DecisionSummary }) => {
					emitted.push(event);
				},
			};
			store.setOnChange((action, record) => {
				hub.emit({
					type: action === "create" ? "decision_created" : "decision_resolved",
					data: sanitizeDecision(record),
				});
			});
			store.updateStatus("D-sse-2", {
				status: "resumed",
				decided_by: "alice",
				decision_value: "test",
			});
			expect(emitted).toHaveLength(1);
			expect(emitted[0].type).toBe("decision_resolved");
			expect(emitted[0].data.status).toBe("resumed");
		});

		it("create → decision_created SSE event when wired like main.ts", () => {
			const emitted: Array<{ type: string; data: DecisionSummary }> = [];
			const hub = {
				emit: (event: { type: string; data: DecisionSummary }) => {
					emitted.push(event);
				},
			};
			store.setOnChange((action, record) => {
				hub.emit({
					type: action === "create" ? "decision_created" : "decision_resolved",
					data: sanitizeDecision(record),
				});
			});
			store.create(makeCreateParams({ decision_id: "D-sse-1" }));
			expect(emitted).toHaveLength(1);
			expect(emitted[0].type).toBe("decision_created");
			expect(emitted[0].data.decision_id).toBe("D-sse-1");
			expect(emitted[0].data).not.toHaveProperty("cwd_path");
			expect(emitted[0].data).not.toHaveProperty("session_path");
		});
	});

	describe("listByStatus", () => {
		it("returns records matching the given status", () => {
			store.create(makeCreateParams({ decision_id: "D-1", status: "awaiting_decision" }));
			store.create(makeCreateParams({ decision_id: "D-2", status: "awaiting_decision" }));
			store.create(makeCreateParams({ decision_id: "D-3", status: "closed" }));

			const awaiting = store.listByStatus("awaiting_decision");
			expect(awaiting).toHaveLength(2);
			expect(awaiting.map((r) => r.decision_id)).toEqual(["D-1", "D-2"]);

			const closed = store.listByStatus("closed");
			expect(closed).toHaveLength(1);
			expect(closed[0].decision_id).toBe("D-3");
		});

		it("returns empty array when no matches", () => {
			expect(store.listByStatus("awaiting_decision")).toEqual([]);
		});
	});

	describe("listByProject", () => {
		it("returns all records for a project", () => {
			store.create(makeCreateParams({ decision_id: "D-1", project_id: "proj-A" }));
			store.create(makeCreateParams({ decision_id: "D-2", project_id: "proj-A" }));
			store.create(makeCreateParams({ decision_id: "D-3", project_id: "proj-B" }));

			const projA = store.listByProject("proj-A");
			expect(projA).toHaveLength(2);
			expect(projA.map((r) => r.decision_id)).toEqual(["D-1", "D-2"]);
		});

		it("returns empty array for unknown project", () => {
			expect(store.listByProject("unknown")).toEqual([]);
		});
	});

	describe("sweepExpired", () => {
		it("deletes expired awaiting decisions and returns the full records", () => {
			const pastExpiry = new Date(Date.now() - 1000).toISOString();
			const futureExpiry = new Date(Date.now() + 60_000).toISOString();

			store.create(
				makeCreateParams({ decision_id: "D-expired-1", expires_at: pastExpiry }),
			);
			store.create(
				makeCreateParams({
					decision_id: "D-expired-2",
					expires_at: pastExpiry,
					pipeline_id: "pipe-2",
				}),
			);
			store.create(
				makeCreateParams({ decision_id: "D-valid", expires_at: futureExpiry }),
			);

			const swept = store.sweepExpired();
			expect(swept).toHaveLength(2);
			expect(swept.map((r) => r.decision_id).sort()).toEqual([
				"D-expired-1",
				"D-expired-2",
			]);
			// Full records carry everything the lifecycle sweep needs.
			const first = swept.find((r) => r.decision_id === "D-expired-1")!;
			expect(first.status).toBe("awaiting_decision");
			expect(first.cwd_path).toBe("/tmp/work/uuid-1");
			expect(first.event_json).toBe(JSON.stringify(makeEvent()));

			expect(store.get("D-expired-1")).toBeUndefined();
			expect(store.get("D-expired-2")).toBeUndefined();
			expect(store.get("D-valid")).toBeDefined();
		});

		it("only sweeps awaiting_decision status", () => {
			const pastExpiry = new Date(Date.now() - 1000).toISOString();

			store.create(
				makeCreateParams({
					decision_id: "D-awaiting",
					status: "awaiting_decision",
					expires_at: pastExpiry,
				}),
			);
			store.create(
				makeCreateParams({
					decision_id: "D-closed",
					status: "closed",
					expires_at: pastExpiry,
				}),
			);

			const swept = store.sweepExpired();
			expect(swept.map((r) => r.decision_id)).toEqual(["D-awaiting"]);
			expect(store.get("D-closed")).toBeDefined();
		});

		it("returns empty array when nothing is expired", () => {
			expect(store.sweepExpired()).toEqual([]);
		});

		it("is atomic: a failing delete leaves every row intact", () => {
			const pastExpiry = new Date(Date.now() - 1000).toISOString();
			store.create(
				makeCreateParams({ decision_id: "D-a", expires_at: pastExpiry }),
			);
			store.create(
				makeCreateParams({
					decision_id: "D-b",
					expires_at: pastExpiry,
					pipeline_id: "pipe-2",
				}),
			);

			// Abort the sweep mid-delete via a SQLite trigger — nothing may be lost.
			const sideChannel = new Database(join(dir, "decisions.db"));
			sideChannel.exec(
				`CREATE TRIGGER abort_sweep BEFORE DELETE ON decisions
				 WHEN OLD.decision_id = 'D-b'
				 BEGIN SELECT RAISE(ABORT, 'boom'); END`,
			);
			sideChannel.close();

			expect(() => store.sweepExpired()).toThrow(/boom/);
			expect(store.get("D-a")).toBeDefined();
			expect(store.get("D-b")).toBeDefined();
		});
	});

	describe("invalidateByMr", () => {
		it("invalidates only awaiting decisions whose event_json mrIid matches", () => {
			store.create(
				makeCreateParams({
					decision_id: "D-mr281-a",
					project_id: "proj-A",
					event_json: JSON.stringify(makeEvent("proj-A", "pipe-1", 281)),
				}),
			);
			store.create(
				makeCreateParams({
					decision_id: "D-mr282",
					project_id: "proj-A",
					pipeline_id: "pipe-2",
					event_json: JSON.stringify(makeEvent("proj-A", "pipe-2", 282)),
				}),
			);
			store.create(
				makeCreateParams({
					decision_id: "D-mr281-b",
					project_id: "proj-A",
					pipeline_id: "pipe-3",
					event_json: JSON.stringify(makeEvent("proj-A", "pipe-3", 281)),
				}),
			);
			store.create(
				makeCreateParams({
					decision_id: "D-other-proj",
					project_id: "proj-B",
					event_json: JSON.stringify(makeEvent("proj-B", "pipe-4", 281)),
				}),
			);

			const invalidated = store.invalidateByMr("proj-A", 281);

			expect(invalidated.map((r) => r.decision_id).sort()).toEqual(["D-mr281-a", "D-mr281-b"]);
			expect(invalidated[0].status).toBe("awaiting_decision");
			expect(store.get("D-mr281-a")!.status).toBe("invalidated");
			expect(store.get("D-mr281-b")!.status).toBe("invalidated");
			expect(store.get("D-mr282")!.status).toBe("awaiting_decision");
			expect(store.get("D-other-proj")!.status).toBe("awaiting_decision");
		});

		it("skips rows with missing or mismatched mrIid in event_json", () => {
			store.create(
				makeCreateParams({
					decision_id: "D-no-mr",
					project_id: "proj-A",
					event_json: JSON.stringify(makeEvent("proj-A", "pipe-1")),
				}),
			);
			store.create(
				makeCreateParams({
					decision_id: "D-corrupt",
					project_id: "proj-A",
					event_json: "{not-json",
				}),
			);

			expect(store.invalidateByMr("proj-A", 281)).toEqual([]);
			expect(store.get("D-no-mr")!.status).toBe("awaiting_decision");
			expect(store.get("D-corrupt")!.status).toBe("awaiting_decision");
		});

		it("never transitions terminal-state rows even when mrIid matches", () => {
			store.create(
				makeCreateParams({
					decision_id: "D-awaiting",
					event_json: JSON.stringify(makeEvent("proj-1", "pipe-1", 10)),
				}),
			);
			store.create(
				makeCreateParams({
					decision_id: "D-closed",
					status: "closed",
					event_json: JSON.stringify(makeEvent("proj-1", "pipe-2", 10)),
				}),
			);

			const invalidated = store.invalidateByMr("proj-1", 10);

			expect(invalidated.map((r) => r.decision_id)).toEqual(["D-awaiting"]);
			expect(store.get("D-closed")!.status).toBe("closed");
		});
	});

	describe("invalidateByProject", () => {
		it("invalidates all awaiting decisions of the project and returns them", () => {
			store.create(makeCreateParams({ decision_id: "D-1", project_id: "proj-A" }));
			store.create(makeCreateParams({ decision_id: "D-2", project_id: "proj-A", pipeline_id: "pipe-2" }));
			store.create(makeCreateParams({ decision_id: "D-other", project_id: "proj-B" }));

			const invalidated = store.invalidateByProject("proj-A");

			expect(invalidated.map((r) => r.decision_id)).toEqual(["D-1", "D-2"]);
			// Returned records carry the pre-invalidation state (cleanup + notify).
			expect(invalidated[0].status).toBe("awaiting_decision");
			expect(invalidated[0].cwd_path).toBe("/tmp/work/uuid-1");
			expect(invalidated[0].event_json).toBe(JSON.stringify(makeEvent()));

			const d1 = store.get("D-1")!;
			expect(d1.status).toBe("invalidated");
			expect(d1.decided_by).toBe("system:new-pipeline");
			expect(d1.decided_at).toBeTruthy();
			expect(store.get("D-2")!.status).toBe("invalidated");
			// Other projects untouched.
			expect(store.get("D-other")!.status).toBe("awaiting_decision");
		});

		it("never transitions terminal-state rows", () => {
			const terminal: DecisionStatus[] = [
				"resumed",
				"closed",
				"dropped",
				"expired",
				"invalidated",
			];
			for (const status of terminal) {
				store.create(makeCreateParams({ decision_id: `D-${status}`, status }));
			}
			store.create(makeCreateParams({ decision_id: "D-awaiting" }));

			const invalidated = store.invalidateByProject("proj-1");

			expect(invalidated.map((r) => r.decision_id)).toEqual(["D-awaiting"]);
			for (const status of terminal) {
				expect(store.get(`D-${status}`)!.status).toBe(status);
			}
		});

		it("returns empty array when the project has no awaiting decisions", () => {
			store.create(makeCreateParams({ decision_id: "D-closed", status: "closed" }));
			expect(store.invalidateByProject("proj-1")).toEqual([]);
			expect(store.invalidateByProject("proj-unknown")).toEqual([]);
			expect(store.get("D-closed")!.status).toBe("closed");
		});
	});

	describe("persistence", () => {
		it("persists across reopen (real SQLite file)", () => {
			store.create(makeCreateParams({ decision_id: "D-persist" }));
			store.close();

			const reopened = new DecisionStore(join(dir, "decisions.db"));
			const record = reopened.get("D-persist");
			expect(record).toBeDefined();
			expect(record!.decision_id).toBe("D-persist");
			reopened.close();

			// keep afterEach close() idempotent
			store = new DecisionStore(join(dir, "decisions.db"));
		});
	});
});

describe("DecisionStore — oos_paths（G3 扩围文件清单，ADR-0009）", () => {
	let dir: string;
	let store: DecisionStore;

	beforeEach(() => {
		dir = mkdtempSync(join(tmpdir(), "decision-store-oos-"));
		store = new DecisionStore(join(dir, "decisions.db"));
	});

	afterEach(() => {
		store.close();
		rmSync(dir, { recursive: true, force: true });
	});

	it("create 写入 oos_paths → get 原样返回；缺省为 null", () => {
		const oos = ["a/src/test/java/XTest.java", "docs/y.md"];
		store.create({
			...makeCreateParams({ decision_id: "D-oos-1" }),
			oos_paths: JSON.stringify(oos),
		});
		expect(store.get("D-oos-1")!.oos_paths).toBe(JSON.stringify(oos));

		store.create(makeCreateParams({ decision_id: "D-oos-2" }));
		expect(store.get("D-oos-2")!.oos_paths).toBeNull();
	});

	it("迁移：legacy 库无 oos_paths 列 → 构造时自动补列，读写正常", () => {
		const legacyDb = join(dir, "legacy.db");
		const db = new Database(legacyDb);
		db.exec(`CREATE TABLE decisions (
			decision_id TEXT PRIMARY KEY,
			pipeline_id TEXT NOT NULL,
			project_id TEXT NOT NULL,
			event_json TEXT NOT NULL,
			cwd_path TEXT NOT NULL,
			session_path TEXT NOT NULL,
			branch TEXT NOT NULL,
			status TEXT NOT NULL DEFAULT 'awaiting_decision',
			created_at TEXT NOT NULL,
			expires_at TEXT NOT NULL,
			decided_by TEXT,
			decision_value TEXT,
			remark TEXT,
			decided_at TEXT
		)`);
		db.close();

		const migrated = new DecisionStore(legacyDb);
		migrated.create({
			...makeCreateParams({ decision_id: "D-legacy" }),
			oos_paths: JSON.stringify(["t.java"]),
		});
		expect(migrated.get("D-legacy")!.oos_paths).toBe(JSON.stringify(["t.java"]));
		migrated.close();
	});
});
