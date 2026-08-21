/**
 * E2E acceptance gate for repair-replay tickets 01/02/03 (ADR-0012).
 *
 *   (a) 同 MR 二次 pipeline：命中 session 存档 → replayChanges 被触发
 *       （fake worktree 无上游 → skipped 路径，审计可断言）→ 修复 MR 恒一
 *       （第二次终局不新开 MR，只 push 原地更新）
 *   (b) 源 MR 已合并后 pipeline 到达 → 终局跳过闸门：不 spawn worker，
 *       群通知尾注 + lifecycle 事件
 *
 * applied/empty/conflict 的重放语义由真 git 单测覆盖
 * （tests/pipeline/worktree.test.ts + run-repair.test.ts）——e2e 验证编排，
 * 不为 fake worktree 伪造上游仓库。
 */

import { describe, it, expect, afterEach } from "vitest";
import Fastify from "fastify";
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Scheduler } from "../../src/agent-runtime/scheduler.js";
import { CI_REPAIR_SCHEDULING_POLICY } from "../../src/agent/ci-repair-definition.js";
import { SubprocessWorkerManager } from "../../src/worker/manager.js";
import { SidecarGroupSender } from "../../src/notify/sidecar-sender.js";
import { mountWebhook, type WebhookConfig } from "../../src/webhook/receiver.js";
import type { PipelineEvent } from "../../src/types.js";

const PROJECT = "proj-replay";
const MR_IID = 7;
const CONV = "cid-replay";

const webhookConfig: WebhookConfig = {
	webhookSecret: "secret",
	ipAllowlist: [],
	rateLimitMax: 100,
	rateLimitWindowMs: 60_000,
};

function pipelinePayload(opts: {
	pipelineId: number;
	sha: string;
}): Record<string, unknown> {
	return {
		object_kind: "pipeline",
		object_attributes: {
			id: opts.pipelineId,
			ref: `refs/merge-requests/${MR_IID}/head`,
			sha: opts.sha,
			status: "failed",
		},
		merge_request: { source_branch: "feature/replay", iid: MR_IID },
		project: {
			id: PROJECT,
			web_url: `https://gitlab.example.com/${PROJECT}`,
		},
	};
}

function readNotificationLines(path: string): Array<{ title: string; text: string }> {
	try {
		return readFileSync(path, "utf8")
			.trim()
			.split("\n")
			.filter(Boolean)
			.map((line) => JSON.parse(line) as { title: string; text: string });
	} catch {
		return [];
	}
}

/** Read a sidecar JSON from a worker cwd (keepWork keeps them around). */
function readWorkerSidecar<T>(workRoot: string, pipelineId: number, name: string): T | null {
	// worker cwd = <projectId>-<pipelineId>-<uuid>（scheduler 命名）
	const prefix = `${PROJECT}-${pipelineId}-`;
	const dir = readdirSync(workRoot).find((d) => d.startsWith(prefix));
	if (!dir) return null;
	const path = join(workRoot, dir, name);
	if (!existsSync(path)) {
		// fake glab 的 sidecar 写在 repoCwd（worktree 的 repo/ 子目录）
		const repoPath = join(workRoot, dir, "repo", name);
		if (!existsSync(repoPath)) return null;
		return JSON.parse(readFileSync(repoPath, "utf8")) as T;
	}
	return JSON.parse(readFileSync(path, "utf8")) as T;
}

interface ReplayBot {
	root: string;
	workRoot: string;
	dataRoot: string;
	scheduler: Scheduler;
	lifecycle: Array<{ type: string; data: Record<string, unknown> }>;
	inject(payload: Record<string, unknown>): Promise<{ status: number; body: { status: string } }>;
	idle(): Promise<void>;
	teardown(): void;
}

async function buildBot(opts: {
	workerEnv?: Record<string, string>;
	mrTerminalChecker?: (event: PipelineEvent) => Promise<"merged" | "closed" | null>;
	mrTerminalSkipNotifier?: (event: PipelineEvent, state: "merged" | "closed") => Promise<void>;
} = {}): Promise<ReplayBot> {
	const root = mkdtempSync(join(tmpdir(), "replay-e2e-"));
	const dataRoot = join(root, "data");
	const workRoot = join(root, "work");
	mkdirSync(dataRoot, { recursive: true });
	mkdirSync(workRoot, { recursive: true });

	const notifications = new SidecarGroupSender(join(dataRoot, "logs", "dingtalk-fake.jsonl"));
	const lifecycle: Array<{ type: string; data: Record<string, unknown> }> = [];

	const manager = new SubprocessWorkerManager({
		timeoutMs: 60_000,
		keepWork: true,
		env: {
			CIHEAL_GLAB_MODE: "fake",
			CIHEAL_DINGTALK_MODE: "fake",
			CIHEAL_WORKTREE_MODE: "fake",
			CIHEAL_DATA_ROOT: dataRoot,
			CIHEAL_AGENT_MODE: "real",
			CIHEAL_SESSION_FACTORY: "stub",
			CIHEAL_STUB_FIX_KIND: "class1-test-bug",
			...opts.workerEnv,
		},
	});

	const scheduler = new Scheduler({
		workerManager: manager,
		workRoot,
		policy: CI_REPAIR_SCHEDULING_POLICY,
		maxWorkers: 1,
		...(opts.mrTerminalChecker ? { mrTerminalChecker: opts.mrTerminalChecker } : {}),
		...(opts.mrTerminalChecker
			? {
					// 与 main.ts 接线同构：路由到项目群，文案带终局状态尾注。
					mrTerminalSkipNotifier: async (
						event: PipelineEvent,
						state: "merged" | "closed",
					) => {
						await notifications.sendTo(CONV, {
							title: "CI 自愈终局跳过",
							text: `项目 ${event.projectId} pipeline ${event.pipelineId}（MR !${event.mrIid}）源 MR ${state === "merged" ? "已合并" : "已关闭"}，跳过自愈。`,
						});
					},
				}
			: {}),
		onLifecycleEvent: (type, data) => lifecycle.push({ type, data }),
	});

	const app = Fastify({ logger: false });
	await mountWebhook(app, { scheduler, config: webhookConfig });

	return {
		root,
		workRoot,
		dataRoot,
		scheduler,
		lifecycle,
		async inject(payload) {
			const res = await app.inject({
				method: "POST",
				url: "/webhook/gitlab?repair=1",
				headers: { "x-gitlab-token": "secret" },
				payload,
			});
			return { status: res.statusCode, body: res.json() as { status: string } };
		},
		idle: () => scheduler.idle(),
		teardown: () => {
			rmSync(root, { recursive: true, force: true });
			void app.close();
		},
	};
}

const bots: ReplayBot[] = [];
afterEach(() => {
	for (const bot of bots.splice(0)) bot.teardown();
});

describe("repair replay + MR-terminal gate e2e (ADR-0012)", () => {
	it(
		"链路 (a)：同 MR 二次 pipeline 命中存档 → replayChanges 触发（审计可断言）→ 修复 MR 恒一",
		async () => {
			const bot = await buildBot({
				workerEnv: { CIHEAL_STUB_EXISTING_MR: "after-first" },
			});
			bots.push(bot);

			// 第一次修复：新开修复 MR
			expect(
				(await bot.inject(pipelinePayload({ pipelineId: 3001, sha: "shaaaaaaaaa1" }))).status,
			).toBe(202);
			await bot.idle();

			// 第一次终局：outcome mr → session 已存档到 mr-sessions
			const archivePath = join(bot.dataRoot, "mr-sessions", `${PROJECT}-${MR_IID}.jsonl`);
			expect(existsSync(archivePath)).toBe(true);
			const firstTrace = readWorkerSidecar<Record<string, unknown>>(bot.workRoot, 3001, "audit-trace.json");
			expect(firstTrace?.outcome).toBe("mr");

			// 第二次修复（同 MR 新 sha）：命中存档 → replay 触发（fake worktree 无上游 → skipped）
			expect(
				(await bot.inject(pipelinePayload({ pipelineId: 3002, sha: "shaaaaaaaaa2" }))).status,
			).toBe(202);
			await bot.idle();

			const secondTrace = readWorkerSidecar<Record<string, unknown>>(bot.workRoot, 3002, "audit-trace.json");
			expect(secondTrace?.outcome).toBe("mr");
			// 重放审计：来自第一次 pipeline，fake worktree 无上游 → skipped
			expect(secondTrace?.replay).toEqual({
				fromPipeline: 3001,
				commitRange: "",
				outcome: "skipped",
			});
			// ADR-0007 session 复用照旧生效
			expect(secondTrace?.reusedFromPipeline).toBe(3001);

			// 修复 MR 恒一：两次终局只 create 了一个 MR（第二次走原地更新路径）
			const creates = readWorkerSidecar<Array<Record<string, unknown>>>(
				bot.workRoot,
				3002,
				"glab-mr-creates.json",
			);
			// 第二个 worker 的 sidecar 记录的是它自己 cwd 的调用——第二次没新开 MR → 无 create 记录
			expect(creates).toBeNull();
			const firstCreates = readWorkerSidecar<Array<Record<string, unknown>>>(
				bot.workRoot,
				3001,
				"glab-mr-creates.json",
			);
			expect(firstCreates).toHaveLength(1);
		},
		60_000,
	);

	it("链路 (b)：源 MR 已合并 → 终局跳过闸门，不 spawn worker，通知尾注留痕", async () => {
		let checkerCalls = 0;
		const bot = await buildBot({
			mrTerminalChecker: async () => {
				checkerCalls += 1;
				return "merged";
			},
		});
		bots.push(bot);

		const res = await bot.inject(pipelinePayload({ pipelineId: 3101, sha: "merged0000001" }));
		expect(res.status).toBe(202);
		expect(res.body.status).toBe("queued");

		await bot.idle();

		expect(checkerCalls).toBe(1);
		// 不起 worker：workRoot 无任何 worker cwd
		expect(readdirSync(bot.workRoot)).toEqual([]);
		expect(bot.lifecycle).toContainEqual({
			type: "pipeline_mr_terminal_skipped",
			data: {
				pipelineId: 3101,
				projectId: PROJECT,
				mrIid: MR_IID,
				sha: "merged0000001",
				state: "merged",
			},
		});
		const notes = readNotificationLines(join(bot.root, "data", "logs", "dingtalk-fake.jsonl"));
		expect(notes.some((n) => n.text.includes("源 MR 已合并"))).toBe(true);
		expect(notes.some((n) => n.text.includes("跳过自愈"))).toBe(true);
	}, 30_000);
});
