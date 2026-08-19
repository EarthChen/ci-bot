import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, writeFileSync, existsSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	saveMrSession,
	findMrSession,
	removeMrSession,
	evictMrSessions,
	MR_SESSION_MAX_ENTRIES,
} from "../../src/pipeline/mr-session-store.js";
import type { PipelineEvent } from "../../src/types.js";

/**
 * MR session archive（跨 pipeline 复用，ADR-0007）：成功终局保留 Pi
 * session jsonl，同一 MR 后续 pipeline 命中后 compact+continue，
 * 省去重新认识仓库的定向 turn。
 */
describe("mr-session-store", () => {
	let root: string;
	let sourcePath: string;

	const event = (over: Partial<PipelineEvent> = {}): PipelineEvent => ({
		projectId: "31041",
		pipelineId: 100033538,
		ref: "refs/merge-requests/281/head",
		sha: "abc1234567890",
		projectUrl: "https://git.example.com/g/p",
		mrIid: 281,
		...over,
	});

	beforeEach(() => {
		root = mkdtempSync(join(tmpdir(), "mr-session-store-"));
		process.env.CIHEAL_DATA_ROOT = root;
		sourcePath = join(root, "source-session.jsonl");
		writeFileSync(sourcePath, '{"type":"header"}\n{"role":"user"}\n');
	});

	afterEach(() => {
		rmSync(root, { recursive: true, force: true });
		delete process.env.CIHEAL_DATA_ROOT;
	});

	it("save → find 往返：文件与元数据完整", () => {
		const saved = saveMrSession(event(), sourcePath, "mr");
		expect(saved).not.toBeNull();
		expect(existsSync(saved!.sessionPath)).toBe(true);
		expect(readFileSync(saved!.sessionPath, "utf8")).toContain("header");

		const found = findMrSession(event());
		expect(found).not.toBeNull();
		expect(found!.sessionPath).toBe(saved!.sessionPath);
		expect(found!.meta).toMatchObject({
			projectId: "31041",
			mrIid: 281,
			pipelineId: 100033538,
			outcome: "mr",
		});
	});

	it("latest-wins：同 MR 再次保存覆盖旧档（新 pipeline 元数据）", () => {
		saveMrSession(event(), sourcePath, "mr");
		const newer = join(root, "newer.jsonl");
		writeFileSync(newer, '{"v":2}\n');
		saveMrSession(event({ pipelineId: 100033999, sha: "def456" }), newer, "mr");

		const found = findMrSession(event());
		expect(found!.meta.pipelineId).toBe(100033999);
		expect(readFileSync(found!.sessionPath, "utf8")).toContain('"v":2');
	});

	it("无 mrIid（push pipeline）→ 不保存也不命中", () => {
		const noMr = event();
		delete (noMr as { mrIid?: number }).mrIid;
		expect(saveMrSession(noMr, sourcePath, "mr")).toBeNull();
		expect(findMrSession(noMr)).toBeNull();
	});

	it("源文件不存在 → 返回 null 且不落档", () => {
		expect(saveMrSession(event(), join(root, "missing.jsonl"), "mr")).toBeNull();
		expect(findMrSession(event())).toBeNull();
	});

	it("LRU 上限：超出 cap 淘汰最旧条目", () => {
		// 直接测淘汰逻辑：造 3 个 MR 存档，cap=2 淘汰最旧
		for (const mr of [1, 2, 3]) {
			const src = join(root, `src-${mr}.jsonl`);
			writeFileSync(src, `mr-${mr}\n`);
			saveMrSession(event({ projectId: "P", mrIid: mr, pipelineId: mr }), src, "mr");
		}
		evictMrSessions(join(root, "mr-sessions"), 2);
		expect(findMrSession(event({ projectId: "P", mrIid: 1 }))).toBeNull();
		expect(findMrSession(event({ projectId: "P", mrIid: 2 }))).not.toBeNull();
		expect(findMrSession(event({ projectId: "P", mrIid: 3 }))).not.toBeNull();
	});

	it("cap 常量为正", () => {
		expect(MR_SESSION_MAX_ENTRIES).toBeGreaterThan(0);
	});

	it("removeMrSession：MR 终局删除存档（jsonl+meta），find 不再命中", () => {
		saveMrSession(event(), sourcePath, "mr");
		expect(removeMrSession("31041", 281)).toBe(true);
		expect(findMrSession(event())).toBeNull();
		// 重复删除 → false（幂等）
		expect(removeMrSession("31041", 281)).toBe(false);
	});

	it("removeMrSession：无存档 → false，不报错；不碰其他 MR 存档", () => {
		saveMrSession(event({ mrIid: 300 }), sourcePath, "mr");
		expect(removeMrSession("31041", 999)).toBe(false);
		expect(findMrSession(event({ mrIid: 300 }))).not.toBeNull();
	});
});
