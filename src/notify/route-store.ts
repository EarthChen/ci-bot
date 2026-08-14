/**
 * Persistent store for dynamic webhook routes (project pattern → DingTalk group).
 *
 * Port of code-review-bot's WebhookRouteStore (src/webhook/route_store.py):
 * same table shape and upsert-on-conflict semantics. Backed by better-sqlite3
 * (synchronous API, WAL mode) so the main process can resolve routes while a
 * future out-of-process writer (e.g. a CLI tool) safely shares the file.
 */

import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import Database from "better-sqlite3";

const CREATE_TABLE_SQL = `
	CREATE TABLE IF NOT EXISTS webhook_routes (
		id INTEGER PRIMARY KEY AUTOINCREMENT,
		pattern TEXT NOT NULL UNIQUE,
		conversation_id TEXT NOT NULL,
		created_by TEXT NOT NULL DEFAULT '',
		created_at TEXT NOT NULL
	)
`;

export interface WebhookRoute {
	readonly pattern: string;
	readonly conversationId: string;
	readonly createdBy: string;
	readonly createdAt: string;
}

export class WebhookRouteStore {
	private readonly db: Database.Database;

	constructor(dbPath: string) {
		mkdirSync(dirname(dbPath), { recursive: true });
		this.db = new Database(dbPath);
		this.db.pragma("journal_mode = WAL");
		this.db.exec(CREATE_TABLE_SQL);
	}

	/** Insert or replace the route keyed by pattern. */
	add(pattern: string, conversationId: string, createdBy = ""): void {
		if (!pattern.trim()) {
			throw new Error("route pattern must not be blank");
		}
		if (!conversationId.trim()) {
			throw new Error("route conversationId must not be blank");
		}
		this.db
			.prepare(
				`INSERT INTO webhook_routes (pattern, conversation_id, created_by, created_at)
				 VALUES (?, ?, ?, ?)
				 ON CONFLICT(pattern) DO UPDATE SET
				 conversation_id=excluded.conversation_id,
				 created_by=excluded.created_by,
				 created_at=excluded.created_at`,
			)
			.run(pattern, conversationId, createdBy, new Date().toISOString());
	}

	/** Remove a route; reports whether it existed. */
	remove(pattern: string): boolean {
		const result = this.db
			.prepare("DELETE FROM webhook_routes WHERE pattern = ?")
			.run(pattern);
		return result.changes > 0;
	}

	/** All routes in insertion order. */
	list(): WebhookRoute[] {
		const rows = this.db
			.prepare(
				"SELECT pattern, conversation_id, created_by, created_at FROM webhook_routes ORDER BY id",
			)
			.all() as Array<{
			pattern: string;
			conversation_id: string;
			created_by: string;
			created_at: string;
		}>;
		return rows.map((row) => ({
			pattern: row.pattern,
			conversationId: row.conversation_id,
			createdBy: row.created_by,
			createdAt: row.created_at,
		}));
	}

	/** pattern → conversationId mapping (feeds ProjectRouter's dynamic layer). */
	getMapping(): Readonly<Record<string, string>> {
		const mapping: Record<string, string> = {};
		for (const route of this.list()) {
			mapping[route.pattern] = route.conversationId;
		}
		return mapping;
	}

	close(): void {
		this.db.close();
	}
}
