/**
 * End-to-end fixture test (ticket 02): real agent runner path.
 *
 * Drives the REAL `RealAgentRunner` (budget accumulation, structured-result
 * parsing, G3 validation, MR creation, DingTalk notification) through a stub
 * `createAgentSession` that returns canned diagnosis + fix diff — no live LLM.
 *
 * Per spec test decision: single seam (webhook → MR → DingTalk), fixture
 * replaces the agent, glab/DingTalk are fakes. Tests verify EXTERNAL behavior
 * (MR diff correctness, notification delivery, budget breach handling), not
 * implementation details (pi SDK internals, skill triggering).
 *
 * This test is the WHY:
 *  - The real runner parses the agent's structured JSON output and routes it
 *    to MR/escalation correctly (not just "an agent ran").
 *  - Budget soft limit fires abort + DingTalk alert when a turn overshoots
 *    (the safety invariant that keeps the bot from burning tokens unbounded).
 */

import { describe, it, expect } from "vitest";
import Fastify, { type FastifyInstance } from "fastify";
import { mkdtemp, rm, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Scheduler } from "../../src/agent-runtime/scheduler.js";
import { CI_REPAIR_SCHEDULING_POLICY } from "../../src/agent/ci-repair-definition.js";
import { SubprocessWorkerManager } from "../../src/worker/manager.js";
import { mountWebhook } from "../../src/webhook/receiver.js";
import { InMemoryDingTalkNotifier } from "../../src/notify/dingtalk.js";
import { createEscalationNotifier } from "../../src/notify/escalation-notifier.js";
import { ProjectRouter } from "../../src/notify/project-router.js";

const WEBHOOK_SECRET = "test-secret-token";

function pipelineFailedBody(
	projectId: string | number,
	pipelineId: number,
	ref = "main",
	sha = "abc1234567890",
): unknown {
	return {
		object_kind: "pipeline",
		object_attributes: { id: pipelineId, ref, sha, status: "failed" },
		merge_request: { source_branch: ref, iid: pipelineId },
		project: { id: projectId, web_url: `https://gitlab.example.com/${projectId}` },
	};
}

async function postWebhook(
	base: string,
	body: unknown,
	token = WEBHOOK_SECRET,
): Promise<{ status: number; json: unknown }> {
	const res = await fetch(`${base}/webhook?repair=1`, {
		method: "POST",
		headers: { "content-type": "application/json", "x-gitlab-token": token },
		body: JSON.stringify(body),
	});
	const text = await res.text();
	let json: unknown = null;
	try {
		json = JSON.parse(text);
	} catch {
		json = text;
	}
	return { status: res.status, json };
}

/** Find the latest worker cwd under a root and read a sidecar JSON. */
async function readSidecar<T>(root: string, name: string): Promise<T | null> {
	const { readdir } = await import("node:fs/promises");
	const entries = await readdir(root, { withFileTypes: true });
	const dirs = entries.filter((e) => e.isDirectory()).map((e) => e.name);
	for (const d of [...dirs].reverse()) {
		try {
			const raw = await readFile(join(root, d, name), "utf8");
			return JSON.parse(raw) as T;
		} catch {
			// try next dir
		}
	}
	return null;
}

/** Set up an isolated bot instance (app + scheduler + worker manager). */
async function setupBot(env: Record<string, string>): Promise<{
	app: FastifyInstance;
	scheduler: Scheduler;
	base: string;
	workRoot: string;
	/** Main-process routed escalation recorder (T04). */
	escalations: InMemoryDingTalkNotifier;
	cleanup: () => Promise<void>;
}> {
	const workRoot = await mkdtemp(join(tmpdir(), "ciheal-real-"));
	const workerManager = new SubprocessWorkerManager({
		timeoutMs: 60_000,
		keepWork: true,
		env: {
			// Real runner path, but session is a stub returning canned results.
			CIHEAL_AGENT_MODE: "real",
			CIHEAL_SESSION_FACTORY: "stub",
			// Fake worktree: git init + seed canned repo (no real GitLab clone).
			CIHEAL_WORKTREE_MODE: "fake",
			...env,
		},
	});
	// T04: escalated notifications are main-process + routed (ProjectRouter).
	const escalations = new InMemoryDingTalkNotifier();
	const scheduler = new Scheduler({
		workerManager,
		workRoot,
		maxWorkers: 1,
		policy: CI_REPAIR_SCHEDULING_POLICY,
		escalationNotifier: createEscalationNotifier({
			router: new ProjectRouter({}, "cid-e2e-default"),
			sender: escalations,
		}),
	});
	const app = Fastify({ logger: false });
	await mountWebhook(app, {
		scheduler,
		config: {
			webhookSecret: WEBHOOK_SECRET,
			ipAllowlist: [],
			rateLimitMax: 1000,
			rateLimitWindowMs: 60_000,
		},
	});
	await app.listen({ port: 0, host: "127.0.0.1" });
	const addr = app.server.address();
	const base = `http://127.0.0.1:${(addr as { port: number }).port}`;
	return {
		app,
		scheduler,
		base,
		workRoot,
		escalations,
		cleanup: async () => {
			await app.close();
			await rm(workRoot, { recursive: true, force: true }).catch(() => {});
		},
	};
}

describe("real agent runner: webhook → MR → DingTalk (ticket 02 fixture)", () => {
	it("processes a class-1 failure via real runner into a test-only MR + success DingTalk", async () => {
		const bot = await setupBot({});
		try {
			const { status, json } = await postWebhook(
				bot.base,
				pipelineFailedBody("proj-real-1", 800_100, "feature/y", "cafebabedeadbeef"),
			);
			expect(status).toBe(202);
			expect(json).toEqual({ status: "queued" });
			await bot.scheduler.idle();

			// Exactly one MR outcome recorded (agent creates the MR, returns
			// mrUrl; bot records via audit-trace.json). Assert on the
			// authoritative git diff, not a sidecar the bot no longer writes.
			const audit = await readSidecar<{
				event: { projectId: string };
				outcome: string;
				diagnosis: { failureClass: number; summary: string };
				mrUrl?: string;
				diff: string;
			}>(bot.workRoot, "audit-trace.json");
			expect(audit).not.toBeNull();
			expect(audit!.outcome).toBe("mr");
			expect(audit!.mrUrl).toBeTruthy();
			expect(audit!.event.projectId).toBe("proj-real-1");
			expect(audit!.diagnosis.failureClass).toBe(1);
			expect(audit!.diff).toContain("CalculatorTest");
			expect(audit!.diff).not.toContain("src/main/");

			// Success DingTalk sent exactly once.
			const dingtalk = await readSidecar<Array<{ title: string }>>(
				bot.workRoot,
				"dingtalk-sent.json",
			);
			expect(dingtalk).not.toBeNull();
			expect(dingtalk!.length).toBe(1);
			expect(dingtalk![0].title).toContain("成功");
		} finally {
			await bot.cleanup();
		}
	});

	it("enforces G3 via real runner: a src/main fix escalates with no MR", async () => {
		const bot = await setupBot({ CIHEAL_STUB_FIX_KIND: "src-main" });
		try {
			const { status } = await postWebhook(
				bot.base,
				pipelineFailedBody("proj-real-g3", 800_200, "main", "feedface0011223344"),
			);
			expect(status).toBe(202);
			await bot.scheduler.idle();

			// No MR created — G3 blocked the production-path fix.
			const mrs = await readSidecar<Array<{ projectId: string }>>(
				bot.workRoot,
				"glab-mr-creates.json",
			);
			expect(mrs).toBeNull();

			// T04: escalation 通知移至主进程路由（worker sidecar 为空）。
			const workerSent = await readSidecar<Array<{ title: string }>>(
				bot.workRoot,
				"dingtalk-sent.json",
			);
			expect(workerSent).toBeNull();
			expect(
				bot.escalations.sentGroups.some((g) =>
					g.message.title.includes("转交"),
				),
			).toBe(true);
		} finally {
			await bot.cleanup();
		}
	});

	it("escalates when the agent returns an escalated result (no MR, escalation DingTalk)", async () => {
		const bot = await setupBot({ CIHEAL_STUB_FIX_KIND: "escalate" });
		try {
			const { status } = await postWebhook(
				bot.base,
				pipelineFailedBody("proj-real-esc", 800_300, "main", "1111111111111111"),
			);
			expect(status).toBe(202);
			await bot.scheduler.idle();

			// No MR created — agent returned escalated.
			const mrs = await readSidecar<Array<{ projectId: string }>>(
				bot.workRoot,
				"glab-mr-creates.json",
			);
			expect(mrs).toBeNull();

			// T04: escalation 通知移至主进程路由（worker sidecar 为空）。
			const workerSent = await readSidecar<Array<{ title: string }>>(
				bot.workRoot,
				"dingtalk-sent.json",
			);
			expect(workerSent).toBeNull();
			expect(
				bot.escalations.sentGroups.some((g) =>
					g.message.title.includes("转交"),
				),
			).toBe(true);
		} finally {
			await bot.cleanup();
		}
	});

	it("fires budget abort + DingTalk alert when a turn overshoots the per-turn token limit", async () => {
		// Per-turn limit set very low (100 tokens); stub reports 5000 per turn
		// → trips the per-turn overshoot guard → abort + budget alert + escalate.
		const bot = await setupBot({
			CIHEAL_STUB_TURN_TOKENS: "5000",
			BOT_BUDGET_PER_TURN_TOKENS: "100",
			BOT_BUDGET_TOKENS: "1000000", // total limit high, isolate per-turn path
		});
		try {
			const { status } = await postWebhook(
				bot.base,
				pipelineFailedBody("proj-real-budget", 800_400, "main", "2222222222222222"),
			);
			expect(status).toBe(202);
			await bot.scheduler.idle();

			// Budget breach → escalated, no MR.
			const mrs = await readSidecar<Array<{ projectId: string }>>(
				bot.workRoot,
				"glab-mr-creates.json",
			);
			expect(mrs).toBeNull();

			// Budget alert DingTalk sent (预算告警 title).
			const dingtalk = await readSidecar<Array<{ title: string; text: string }>>(
				bot.workRoot,
				"dingtalk-sent.json",
			);
			expect(dingtalk).not.toBeNull();
			expect(dingtalk!.some((d) => d.title.includes("预算"))).toBe(true);

			// T04: escalation 通知移至主进程路由（worker sidecar 只有预算告警）；
			// 预算超限同样触发 escalated outcome 的主进程通知。
			expect(
				dingtalk!.every((d) => !d.title.includes("转交")),
			).toBe(true);
			expect(
				bot.escalations.sentGroups.some((g) =>
					g.message.title.includes("转交"),
				),
			).toBe(true);
		} finally {
			await bot.cleanup();
		}
	});
});
