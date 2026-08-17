/**
 * Persistent store for human decision state (escalated → awaiting_decision → resolved).
 *
 * Follows the same pattern as WebhookRouteStore (src/notify/route-store.ts):
 * better-sqlite3 with WAL mode, synchronous API, constructor opens db, close() method.
 * Independent db file under DATA_ROOT (not shared with group-routing.db).
 */

import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import Database from "better-sqlite3";

const CREATE_TABLE_SQL = `
	CREATE TABLE IF NOT EXISTS decisions (
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
	)
`;

export type DecisionStatus =
	| "awaiting_decision"
	| "resumed"
	| "closed"
	| "dropped"
	| "expired"
	| "invalidated";

export interface DecisionRecord {
	readonly decision_id: string;
	readonly pipeline_id: string;
	readonly project_id: string;
	readonly event_json: string;
	readonly cwd_path: string;
	readonly session_path: string;
	readonly branch: string;
	readonly status: DecisionStatus;
	readonly created_at: string;
	readonly expires_at: string;
	readonly decided_by: string | null;
	readonly decision_value: string | null;
	readonly remark: string | null;
	readonly decided_at: string | null;
}

export interface CreateDecisionParams {
	readonly decision_id: string;
	readonly pipeline_id: string;
	readonly project_id: string;
	readonly event_json: string;
	readonly cwd_path: string;
	readonly session_path: string;
	readonly branch: string;
	readonly status?: DecisionStatus;
	readonly expires_at: string;
}

export interface UpdateStatusParams {
	readonly status: DecisionStatus;
	readonly decided_by?: string;
	readonly decision_value?: string;
	readonly remark?: string;
}

interface DecisionRow {
	decision_id: string;
	pipeline_id: string;
	project_id: string;
	event_json: string;
	cwd_path: string;
	session_path: string;
	branch: string;
	status: string;
	created_at: string;
	expires_at: string;
	decided_by: string | null;
	decision_value: string | null;
	remark: string | null;
	decided_at: string | null;
}

function rowToRecord(row: DecisionRow): DecisionRecord {
	return {
		decision_id: row.decision_id,
		pipeline_id: row.pipeline_id,
		project_id: row.project_id,
		event_json: row.event_json,
		cwd_path: row.cwd_path,
		session_path: row.session_path,
		branch: row.branch,
		status: row.status as DecisionStatus,
		created_at: row.created_at,
		expires_at: row.expires_at,
		decided_by: row.decided_by,
		decision_value: row.decision_value,
		remark: row.remark,
		decided_at: row.decided_at,
	};
}

export class DecisionStore {
	private readonly db: Database.Database;

	constructor(dbPath: string) {
		mkdirSync(dirname(dbPath), { recursive: true });
		this.db = new Database(dbPath);
		this.db.pragma("journal_mode = WAL");
		this.db.exec(CREATE_TABLE_SQL);
	}

	create(params: CreateDecisionParams): void {
		const now = new Date().toISOString();
		this.db
			.prepare(
				`INSERT INTO decisions (
					decision_id, pipeline_id, project_id, event_json,
					cwd_path, session_path, branch, status, created_at, expires_at
				) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
			)
			.run(
				params.decision_id,
				params.pipeline_id,
				params.project_id,
				params.event_json,
				params.cwd_path,
				params.session_path,
				params.branch,
				params.status ?? "awaiting_decision",
				now,
				params.expires_at,
			);
	}

	get(decisionId: string): DecisionRecord | undefined {
		const row = this.db
			.prepare("SELECT * FROM decisions WHERE decision_id = ?")
			.get(decisionId) as DecisionRow | undefined;
		return row ? rowToRecord(row) : undefined;
	}

	updateStatus(decisionId: string, params: UpdateStatusParams): void {
		const now = new Date().toISOString();
		const result = this.db
			.prepare(
				`UPDATE decisions SET
					status = ?,
					decided_by = COALESCE(?, decided_by),
					decision_value = COALESCE(?, decision_value),
					remark = COALESCE(?, remark),
					decided_at = ?
				WHERE decision_id = ?`,
			)
			.run(
				params.status,
				params.decided_by ?? null,
				params.decision_value ?? null,
				params.remark ?? null,
				now,
				decisionId,
			);
		if (result.changes === 0) {
			throw new Error(`Decision not found: ${decisionId}`);
		}
	}

	listByStatus(status: DecisionStatus): DecisionRecord[] {
		const rows = this.db
			.prepare("SELECT * FROM decisions WHERE status = ? ORDER BY created_at")
			.all(status) as DecisionRow[];
		return rows.map(rowToRecord);
	}

	listByProject(projectId: string): DecisionRecord[] {
		const rows = this.db
			.prepare("SELECT * FROM decisions WHERE project_id = ? ORDER BY created_at")
			.all(projectId) as DecisionRow[];
		return rows.map(rowToRecord);
	}

	sweepExpired(): string[] {
		const now = new Date().toISOString();
		const rows = this.db
			.prepare(
				"SELECT decision_id FROM decisions WHERE status = 'awaiting_decision' AND expires_at < ?",
			)
			.all(now) as Array<{ decision_id: string }>;

		if (rows.length === 0) {
			return [];
		}

		const ids = rows.map((r) => r.decision_id);
		const placeholders = ids.map(() => "?").join(", ");
		this.db
			.prepare(`DELETE FROM decisions WHERE decision_id IN (${placeholders})`)
			.run(...ids);

		return ids;
	}

	close(): void {
		this.db.close();
	}
}
