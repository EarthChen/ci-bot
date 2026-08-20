/**
 * E2E acceptance gate for Ticket 03 — queue coalescence + green short-circuit.
 *
 *   1. Same MR triple webhook (parallel) → one worker for the latest pipeline/sha
 *   2. Superseded queued pipeline → coalescence group notification
 *   3. Green MR at dequeue → skip repair, no worker cwd, green-skip notification
 */

import { describe, it, expect, afterEach } from "vitest";
import Fastify from "fastify";
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Scheduler, type ScheduledWorker } from "../../src/agent-runtime/scheduler.js";
import { CI_REPAIR_SCHEDULING_POLICY } from "../../src/agent/ci-repair-definition.js";
import { SubprocessWorkerManager } from "../../src/worker/manager.js";
import { ProjectRouter } from "../../src/notify/project-router.js";
import { SidecarGroupSender } from "../../src/notify/sidecar-sender.js";
import { mountWebhook, type WebhookConfig } from "../../src/webhook/receiver.js";
import type { PipelineEvent } from "../../src/types.js";

const PROJECT = "proj-coalesce";
const MR_IID = 42;
const CONV = "cid-coalesce";

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
		merge_request: { source_branch: "feature/coalesce", iid: MR_IID },
		project: {
			id: PROJECT,
			web_url: `https://gitlab.example.com/${PROJECT}`,
		},
	};
}

interface CoalesceBot {
	root: string;
	workRoot: string;
	scheduler: Scheduler;
	notifications: SidecarGroupSender;
	lifecycle: Array<{ type: string; data: Record<string, unknown> }>;
	inject(payload: Record<string, unknown>): Promise<{ status: number; body: { status: string } }>;
	idle(): Promise<void>;
	teardown(): void;
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

async function buildBot(opts: {
	greenChecker?: (event: PipelineEvent) => Promise<boolean>;
	workerManager?: ScheduledWorker;
} = {}): Promise<CoalesceBot> {
	const root = mkdtempSync(join(tmpdir(), "coalesce-e2e-"));
	const dataRoot = join(root, "data");
	const workRoot = join(root, "work");
	mkdirSync(dataRoot, { recursive: true });
	mkdirSync(workRoot, { recursive: true });

	const notifications = new SidecarGroupSender(join(dataRoot, "logs", "dingtalk-fake.jsonl"));
	const router = new ProjectRouter({ [PROJECT]: CONV }, "");
	const lifecycle: Array<{ type: string; data: Record<string, unknown> }> = [];

	const manager: ScheduledWorker =
		opts.workerManager ??
		new SubprocessWorkerManager({
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
			},
		});

	const scheduler = new Scheduler({
		workerManager: manager,
		workRoot,
		policy: CI_REPAIR_SCHEDULING_POLICY,
		maxWorkers: 1,
		coalescenceNotifier: async (superseded, superseding) => {
			await notifications.sendTo(CONV, {
				title: `Pipeline #${superseded.pipelineId} 已取消`,
				text: `已被更新的 pipeline #${superseding.pipelineId} 取代`,
			});
		},
		greenSkipNotifier: async (event) => {
			await notifications.sendTo(CONV, {
				title: `Pipeline #${event.pipelineId} 跳过修复`,
				text: "该 MR 最新 pipeline 已通过，无需修复",
			});
		},
		...(opts.greenChecker ? { greenChecker: opts.greenChecker } : {}),
		onLifecycleEvent: (type, data) => lifecycle.push({ type, data }),
	});

	const app = Fastify();
	await mountWebhook(app, {
		scheduler,
		config: webhookConfig,
	});

	return {
		root,
		workRoot,
		scheduler,
		notifications,
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

const roots: CoalesceBot[] = [];
afterEach(() => {
	for (const bot of roots.splice(0)) bot.teardown();
});

describe("queue coalesce + green skip e2e (Ticket 03)", () => {
	it("同 MR 三连 webhook：排队项合并，最终 repair 最新 pipeline/sha", async () => {
		let release: () => void = () => {};
		const gate = new Promise<void>((r) => (release = r));
		const ranPipelineIds: number[] = [];
		const bot = await buildBot({
			workerManager: {
				async run(event) {
					ranPipelineIds.push(event.pipelineId);
					await gate;
					return { kind: "escalated", summary: "held" };
				},
			},
		});
		roots.push(bot);

		expect((await bot.inject(pipelinePayload({ pipelineId: 1001, sha: "sha0000000001" }))).status).toBe(202);
		while (bot.scheduler.stats().running === 0) {
			await new Promise((r) => setTimeout(r, 5));
		}
		expect((await bot.inject(pipelinePayload({ pipelineId: 1002, sha: "sha0000000002" }))).status).toBe(202);
		expect((await bot.inject(pipelinePayload({ pipelineId: 1003, sha: "sha0000000003" }))).status).toBe(202);
		expect(bot.scheduler.stats().queued).toBe(1);
		expect(bot.scheduler.queueDetails()).toContainEqual({
			serialKey: `${PROJECT}:${MR_IID}`,
			pipelineId: 1003,
			status: "queued",
		});

		release();
		await bot.idle();

		expect(ranPipelineIds.sort()).toEqual([1001, 1003]);
		expect(bot.lifecycle.some((e) => e.type === "pipeline_superseded")).toBe(true);
		const notes = readNotificationLines(join(bot.root, "data", "logs", "dingtalk-fake.jsonl"));
		expect(notes.some((n) => n.text.includes("已被更新的 pipeline #1003 取代"))).toBe(true);
	}, 30_000);

	it("绿灯 MR → 出队跳过修复，无 worker cwd，群通知留痕", async () => {
		const bot = await buildBot({
			greenChecker: async () => true,
		});
		roots.push(bot);

		const res = await bot.inject(
			pipelinePayload({ pipelineId: 2001, sha: "green000000001" }),
		);
		expect(res.status).toBe(202);
		expect(res.body.status).toBe("queued");

		await bot.idle();

		expect(readdirSync(bot.workRoot)).toEqual([]);
		expect(bot.lifecycle).toContainEqual({
			type: "pipeline_green_skipped",
			data: {
				pipelineId: 2001,
				projectId: PROJECT,
				mrIid: MR_IID,
				sha: "green000000001",
			},
		});
		const notes = readNotificationLines(join(bot.root, "data", "logs", "dingtalk-fake.jsonl"));
		expect(notes.some((n) => n.text.includes("最新 pipeline 已通过"))).toBe(true);
	}, 30_000);
});
