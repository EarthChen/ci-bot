/**
 * Per-MR session archive — 跨 pipeline session 复用的存储层（ADR-0007）。
 *
 * 修复终局带 MR 成果时（outcome=mr / 部分修复 MR 转交），把 Pi 原生
 * session jsonl 拷到这里（latest-wins）。同一 MR 的后续 pipeline 命中后
 * 走 open → compact → continue，省去重新认识仓库的定向 turn（需求迭代
 * 场景省 30-40%，需求修改场景省 15-25%）。
 *
 * best-effort：任何 I/O 失败返回 null / 记日志，绝不阻断修复主流程。
 */
import {
	copyFileSync,
	existsSync,
	mkdirSync,
	readdirSync,
	readFileSync,
	rmSync,
	statSync,
	writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { resolveMrSessionsDir } from "../config/paths.js";
import { logger } from "../util/log.js";
import type { PipelineEvent } from "../types.js";

/** Archive metadata persisted next to each session file. */
export interface MrSessionMeta {
	readonly projectId: string;
	readonly mrIid: number;
	readonly pipelineId: number;
	readonly sha: string;
	readonly outcome: string;
	readonly savedAt: string;
}

/** A stored session file plus its metadata. */
export interface StoredMrSession {
	readonly sessionPath: string;
	readonly meta: MrSessionMeta;
}

/** LRU cap: distinct MR archives retained under DATA_ROOT/mr-sessions. */
export const MR_SESSION_MAX_ENTRIES = 32;

function storeKey(projectId: string, mrIid: number): string {
	// projectId may contain chars illegal on some FS paths — sanitize like bare/.
	return `${projectId.replace(/[/:]/g, "-")}-${mrIid}`;
}

/**
 * Copy the agent's Pi session jsonl into the per-MR archive (latest wins).
 * Returns the stored entry, or null when not storable (no mrIid, source
 * missing, I/O error) — all non-fatal.
 */
export function saveMrSession(
	event: PipelineEvent,
	sourceSessionPath: string,
	outcome: string,
): StoredMrSession | null {
	if (event.mrIid === undefined) return null;
	try {
		if (!existsSync(sourceSessionPath)) {
			logger.warn(
				{ sourceSessionPath, pipelineId: event.pipelineId },
				"mr session save skipped: source missing",
			);
			return null;
		}
		const dir = resolveMrSessionsDir();
		mkdirSync(dir, { recursive: true });
		const key = storeKey(event.projectId, event.mrIid);
		const sessionPath = join(dir, `${key}.jsonl`);
		const meta: MrSessionMeta = {
			projectId: event.projectId,
			mrIid: event.mrIid,
			pipelineId: event.pipelineId,
			sha: event.sha,
			outcome,
			savedAt: new Date().toISOString(),
		};
		copyFileSync(sourceSessionPath, sessionPath);
		writeFileSync(
			join(dir, `${key}.meta.json`),
			`${JSON.stringify(meta, null, "\t")}\n`,
			"utf8",
		);
		logger.info(
			{ projectId: event.projectId, mrIid: event.mrIid, sessionPath },
			"mr session archived for cross-pipeline reuse",
		);
		evictMrSessions(dir, MR_SESSION_MAX_ENTRIES);
		return { sessionPath, meta };
	} catch (err) {
		logger.warn(
			{
				err: err instanceof Error ? err.message : String(err),
				pipelineId: event.pipelineId,
			},
			"mr session save failed (non-fatal)",
		);
		return null;
	}
}

/**
 * Find the archived session for this event's MR. Returns null when the event
 * has no mrIid, nothing is archived, or the archive is unreadable — callers
 * fall back to a fresh session.
 */
export function findMrSession(
	event: PipelineEvent,
): StoredMrSession | null {
	if (event.mrIid === undefined) return null;
	try {
		const key = storeKey(event.projectId, event.mrIid);
		const sessionPath = join(resolveMrSessionsDir(), `${key}.jsonl`);
		if (!existsSync(sessionPath)) return null;
		const metaPath = join(resolveMrSessionsDir(), `${key}.meta.json`);
		const meta: MrSessionMeta = existsSync(metaPath)
			? (JSON.parse(readFileSync(metaPath, "utf8")) as MrSessionMeta)
			: {
					projectId: event.projectId,
					mrIid: event.mrIid,
					pipelineId: 0,
					sha: "",
					outcome: "unknown",
					savedAt: new Date(statSync(sessionPath).mtimeMs).toISOString(),
				};
		return { sessionPath, meta };
	} catch (err) {
		logger.warn(
			{
				err: err instanceof Error ? err.message : String(err),
				pipelineId: event.pipelineId,
			},
			"mr session lookup failed (falling back to fresh session)",
		);
		return null;
	}
}

/**
 * LRU eviction: keep at most `cap` MR archives (by session file mtime),
 * removing both the jsonl and its meta sidecar. Exported for tests.
 */
export function evictMrSessions(dir: string, cap: number): void {
	try {
		const entries = readdirSync(dir)
			.filter((name) => name.endsWith(".jsonl"))
			.map((name) => {
				const full = join(dir, name);
				return { name, mtimeMs: statSync(full).mtimeMs };
			})
			.sort((a, b) => b.mtimeMs - a.mtimeMs);
		for (const victim of entries.slice(cap)) {
			rmSync(join(dir, victim.name), { force: true });
			rmSync(join(dir, victim.name.replace(/\.jsonl$/, ".meta.json")), {
				force: true,
			});
		}
	} catch {
		// best-effort retention — never break the save path
	}
}

/**
 * Remove this MR's archive (jsonl + meta sidecar) — MR 终局（merge/close）
 * 清理入口。Returns whether an archive actually existed. best-effort：
 * I/O 失败记日志返回 false，绝不抛出。
 */
export function removeMrSession(projectId: string, mrIid: number): boolean {
	try {
		const dir = resolveMrSessionsDir();
		const key = storeKey(projectId, mrIid);
		const sessionPath = join(dir, `${key}.jsonl`);
		const existed = existsSync(sessionPath);
		rmSync(sessionPath, { force: true });
		rmSync(join(dir, `${key}.meta.json`), { force: true });
		if (existed) {
			logger.info({ projectId, mrIid }, "mr session archive removed (MR terminal)");
		}
		return existed;
	} catch (err) {
		logger.warn(
			{
				err: err instanceof Error ? err.message : String(err),
				projectId,
				mrIid,
			},
			"mr session removal failed (non-fatal)",
		);
		return false;
	}
}
