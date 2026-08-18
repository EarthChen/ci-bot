/**
 * E2E acceptance gate for stage exclusion (CIHEAL_SKIP_STAGES):
 *
 *   1. format-only pipeline  webhook with builds=[format failed] → enqueue
 *      returns "skipped": NO worker spawned, no decision row, and the
 *      immediate failure broadcast still fires (visibility independent of
 *      repair scope, grill Q5a)
 *   2. invalidation on skip  a pending awaiting decision is invalidated when
 *      a stage-skipped pipeline arrives for the same project (grill decision
 *      ii): row → invalidated, retained scene removed, routed notification
 *
 * Real subprocess workers + real receiver (mountWebhook) + env-switch DI.
 */

import { describe, it, expect, afterEach } from "vitest";
import Fastify from "fastify";
import {
	mkdirSync,
	mkdtempSync,
	readdirSync,
	rmSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { vi } from "vitest";
import {
	Scheduler,
	parseSkipStages,
} from "../../src/agent-runtime/scheduler.js";
import { CI_REPAIR_SCHEDULING_POLICY } from "../../src/agent/ci-repair-definition.js";
import { SubprocessWorkerManager } from "../../src/worker/manager.js";
import { DecisionStore } from "../../src/decision/store.js";
import { createDecisionLifecycle } from "../../src/decision/lifecycle.js";
import { createEscalationNotifier } from "../../src/notify/escalation-notifier.js";
import { ProjectRouter } from "../../src/notify/project-router.js";
import { InMemoryDingTalkNotifier } from "../../src/notify/dingtalk.js";
import { mountWebhook, type WebhookConfig } from "../../src/webhook/receiver.js";

const PROJECT = "proj-skip";
const CONV = "cid-skip";

const webhookConfig: WebhookConfig = {
	webhookSecret: "secret",
	ipAllowlist: [],
	rateLimitMax: 100,
	rateLimitWindowMs: 60_000,
};

/** GitLab pipeline webhook payload with per-job builds (stage source). */
function pipelinePayload(opts: {
	pipelineId: number;
	builds: Array<{ stage: string; status: string }>;
}): Record<string, unknown> {
	return {
		object_kind: "pipeline",
		object_attributes: {
			id: opts.pipelineId,
			ref: "main",
			sha: "abc1234567890",
			status: "failed",
		},
		merge_request: { source_branch: "main", iid: opts.pipelineId },
		project: {
			id: PROJECT,
			web_url: `https://gitlab.example.com/${PROJECT}`,
		},
		builds: opts.builds.map((b, i) => ({
			id: i + 1,
			name: `job-${b.stage}`,
			...b,
		})),
	};
}

interface SkipBot {
	dataRoot: string;
	workRoot: string;
	store: DecisionStore;
	scheduler: Scheduler;
	escalations: InMemoryDingTalkNotifier;
	broadcasts: ReturnType<typeof vi.fn>;
	inject(payload: Record<string, unknown>): Promise<{ status: number; body: { status: string } }>;
	idle(): Promise<void>;
	teardown(): void;
}

/** Real receiver + scheduler (skipStages=["format"]) + decidable-escalation
 *  repair fixture, so a first pipeline can seed a retained awaiting decision. */
async function buildBot(): Promise<SkipBot> {
	const root = mkdtempSync(join(tmpdir(), "skip-e2e-"));
	const dataRoot = join(root, "data");
	const workRoot = join(root, "work");
	mkdirSync(dataRoot, { recursive: true });
	mkdirSync(workRoot, { recursive: true });

	const store = new DecisionStore(join(dataRoot, "decisions.db"));
	const router = new ProjectRouter({ [PROJECT]: CONV }, "");
	const escalations = new InMemoryDingTalkNotifier();
	const notifier = createEscalationNotifier({ router, sender: escalations });
	const lifecycle = createDecisionLifecycle({ store, router, sender: escalations });

	const manager = new SubprocessWorkerManager({
		timeoutMs: 60_000,
		env: {
			CIHEAL_GLAB_MODE: "fake",
			CIHEAL_DINGTALK_MODE: "fake",
			CIHEAL_WORKTREE_MODE: "fake",
			CIHEAL_DATA_ROOT: dataRoot,
			// Decidable escalation fixture (agent-sourced, with diagnosis).
			CIHEAL_AGENT_MODE: "real",
			CIHEAL_SESSION_FACTORY: "stub",
			CIHEAL_STUB_FIX_KIND: "class3-no-spec",
		},
	});
	const scheduler = new Scheduler({
		workerManager: manager,
		workRoot,
		policy: CI_REPAIR_SCHEDULING_POLICY,
		maxWorkers: 1,
		decisionStore: store,
		escalationNotifier: notifier,
		skipStages: parseSkipStages("format"),
	});

	const broadcasts = vi.fn(async () => {});
	const app = Fastify();
	await mountWebhook(app, {
		scheduler,
		config: webhookConfig,
		pipelineNotifier: { notify: broadcasts },
		onNewPipeline: (event) => lifecycle.onNewPipeline(event),
	});

	return {
		dataRoot,
		workRoot,
		store,
		scheduler,
		escalations,
		broadcasts,
		async inject(payload: Record<string, unknown>) {
			const res = await app.inject({
				method: "POST",
				url: "/webhook?repair=1",
				headers: { "x-gitlab-token": "secret" },
				payload,
			});
			return { status: res.statusCode, body: res.json() };
		},
		idle: () => scheduler.idle(),
		teardown: () => {
			store.close();
			rmSync(root, { recursive: true, force: true });
			void app.close();
		},
	};
}

const roots: SkipBot[] = [];
afterEach(() => {
	for (const bot of roots.splice(0)) bot.teardown();
});

describe("stage exclusion e2e", () => {
	it("format-only pipeline: skipped — no worker, no decision, broadcast kept", async () => {
		const bot = await buildBot();
		roots.push(bot);

		const res = await bot.inject(
			pipelinePayload({
				pipelineId: 900,
				builds: [{ stage: "format", status: "failed" }],
			}),
		);
		expect(res.status).toBe(202);
		expect(res.body).toEqual({ status: "skipped" });
		await bot.idle();

		// No repair work happened: no per-event work dir, no decision row.
		expect(readdirSync(bot.workRoot)).toEqual([]);
		expect(bot.store.listByStatus("awaiting_decision")).toEqual([]);
		// Q5(a): the immediate failure broadcast survives the repair skip.
		expect(bot.broadcasts).toHaveBeenCalledOnce();
		// No routed escalation/decision message for a skipped pipeline.
		expect(bot.escalations.sent).toEqual([]);
		expect(bot.escalations.sentGroups).toEqual([]);
	}, 90_000);

	it("skipped pipeline still invalidates a pending decision (grill ii)", async () => {
		const bot = await buildBot();
		roots.push(bot);

		// 1. A normal (non-excluded) failure → decidable escalation → awaiting
		//    decision with a retained scene.
		const first = await bot.inject(
			pipelinePayload({
				pipelineId: 901,
				builds: [{ stage: "test", status: "failed" }],
			}),
		);
		expect(first.body).toEqual({ status: "queued" });
		await bot.idle();
		const pending = bot.store.listByStatus("awaiting_decision");
		expect(pending).toHaveLength(1);
		const scene = pending[0]!.cwd_path;
		expect(readdirSync(bot.workRoot)).toHaveLength(1);

		// 2. A format-only pipeline arrives for the same project (new id).
		const second = await bot.inject(
			pipelinePayload({
				pipelineId: 902,
				builds: [{ stage: "format", status: "failed" }],
			}),
		);
		expect(second.body).toEqual({ status: "skipped" });
		await bot.idle();

		// (ii): the stale decision is invalidated even though the pipeline
		// was skipped for repair.
		expect(bot.store.listByStatus("awaiting_decision")).toEqual([]);
		expect(bot.store.listByProject(PROJECT)).toMatchObject([
			{ status: "invalidated" },
		]);
		// Retained scene removed.
		expect(readdirSync(bot.workRoot)).toEqual([]);
		expect(scene).not.toBe("");
		// Routed invalidation notification reached the group (alongside the
		// earlier decision message — filter by title, not position).
		const invalidations = bot.escalations.sentGroups.filter(
			(g) =>
				g.conversationId === CONV &&
				g.message.title === "CI 自愈决策已作废",
		);
		expect(invalidations).toHaveLength(1);
		expect(
			invalidations.every((g) => g.message.text.includes("作废")),
		).toBe(true);
	}, 90_000);
});
