import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { DecisionStore } from "../../src/decision/store.js";
import type { DecisionRecord, DecisionStatus } from "../../src/decision/store.js";

function makeEvent(projectId = "proj-1", pipelineId = "pipe-1") {
	return { projectId, pipelineId, sha: "abc123", ref: "main" };
}

function makeCreateParams(overrides: Partial<DecisionRecord> = {}): Omit<
	DecisionRecord,
	"status" | "created_at" | "expires_at" | "decided_by" | "decision_value" | "remark" | "decided_at"
> & { status?: DecisionStatus; expires_at?: string } {
	const now = new Date().toISOString();
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
		it("deletes expired awaiting_decision records and returns their ids", () => {
			const pastExpiry = new Date(Date.now() - 1000).toISOString();
			const futureExpiry = new Date(Date.now() + 60_000).toISOString();

			store.create(
				makeCreateParams({ decision_id: "D-expired-1", expires_at: pastExpiry }),
			);
			store.create(
				makeCreateParams({ decision_id: "D-expired-2", expires_at: pastExpiry }),
			);
			store.create(
				makeCreateParams({ decision_id: "D-valid", expires_at: futureExpiry }),
			);

			const swept = store.sweepExpired();
			expect(swept).toHaveLength(2);
			expect(swept.sort()).toEqual(["D-expired-1", "D-expired-2"]);

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
			expect(swept).toEqual(["D-awaiting"]);
			expect(store.get("D-closed")).toBeDefined();
		});

		it("returns empty array when nothing is expired", () => {
			expect(store.sweepExpired()).toEqual([]);
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
