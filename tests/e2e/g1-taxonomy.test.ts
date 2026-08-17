/**
 * End-to-end fixture test (ticket 03): full G1 taxonomy + spec/doc sync.
 *
 * Six fixtures exercise every G1 failure class through the established seam
 * (webhook → MR / escalation → DingTalk), all via the stub session factory so
 * no live LLM is needed. Verifies EXTERNAL behavior only:
 *   - class 2: stale test + behavior change → MR with test + docs files (doc sync)
 *   - class 3 (spec readable): → MR with new conformance test file
 *   - class 3 (spec unreadable): → escalation, no MR
 *   - class 3 (code ≠ spec): → escalation, no MR
 *   - class 4 (flaky): → escalation + DingTalk
 *   - class 5 (compile error): → early-filter escalation, no agent spawned
 *
 * The class-5 fixture is the budget invariant: a compile/dependency failure
 * must never reach the agent (the early filter intercepts it in bot code).
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
	projectId: string,
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
			void 0; // sidecar may not exist in this dir; try next
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
	const workRoot = await mkdtemp(join(tmpdir(), "ciheal-g1-"));
	const workerManager = new SubprocessWorkerManager({
		timeoutMs: 60_000,
		keepWork: true,
		env: {
			CIHEAL_AGENT_MODE: "real",
			CIHEAL_SESSION_FACTORY: "stub",
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

describe("G1 taxonomy: webhook → MR / escalation → DingTalk (ticket 03)", () => {
	it("class 2: stale test + behavior change → MR with test + docs files (doc sync)", async () => {
		const bot = await setupBot({ CIHEAL_STUB_FIX_KIND: "class2" });
		try {
			const { status } = await postWebhook(
				bot.base,
				pipelineFailedBody("proj-c2", 300_100, "main", "aaa1111111111111"),
			);
			expect(status).toBe(202);
			await bot.scheduler.idle();

			// The agent creates the MR itself (returns mrUrl); the bot records the
			// outcome via audit-trace.json. Assert on the authoritative git diff
			// + outcome, not a sidecar the bot no longer writes.
			const audit = await readSidecar<{
				event: { projectId: string };
				outcome: string;
				diagnosis: { failureClass: number };
				mrUrl?: string;
				diff: string;
			}>(bot.workRoot, "audit-trace.json");
			expect(audit).not.toBeNull();
			expect(audit!.outcome).toBe("mr");
			expect(audit!.mrUrl).toBeTruthy();
			expect(audit!.event.projectId).toBe("proj-c2");
			expect(audit!.diagnosis.failureClass).toBe(2);
			// Doc sync: a docs/ file is in the patch (G2 relevant-paragraph rule).
			expect(audit!.diff).toContain("docs/");
			// Test file also present.
			expect(audit!.diff).toContain("CalculatorTest");
			// G3 honored: no src/main.
			expect(audit!.diff).not.toContain("src/main/");
		} finally {
			await bot.cleanup();
		}
	});

	it("class 3 (spec readable): → MR with new conformance test file", async () => {
		const bot = await setupBot({ CIHEAL_STUB_FIX_KIND: "class3-spec" });
		try {
			const { status } = await postWebhook(
				bot.base,
				pipelineFailedBody("proj-c3ok", 300_200, "main", "bbb2222222222222"),
			);
			expect(status).toBe(202);
			await bot.scheduler.idle();

			const audit = await readSidecar<{
				event: { projectId: string };
				outcome: string;
				diagnosis: { failureClass: number };
				mrUrl?: string;
				diff: string;
			}>(bot.workRoot, "audit-trace.json");
			expect(audit).not.toBeNull();
			expect(audit!.outcome).toBe("mr");
			expect(audit!.mrUrl).toBeTruthy();
			expect(audit!.event.projectId).toBe("proj-c3ok");
			expect(audit!.diagnosis.failureClass).toBe(3);
			// New conformance test file (not the existing CalculatorTest).
			expect(audit!.diff).toContain("Conformance");
			// G3 honored: no src/main.
			expect(audit!.diff).not.toContain("src/main/");
		} finally {
			await bot.cleanup();
		}
	});

	it("class 3 (spec unreadable): → escalation, no MR", async () => {
		const bot = await setupBot({ CIHEAL_STUB_FIX_KIND: "class3-no-spec" });
		try {
			const { status } = await postWebhook(
				bot.base,
				pipelineFailedBody("proj-c3nospec", 300_300, "main", "ccc3333333333333"),
			);
			expect(status).toBe(202);
			await bot.scheduler.idle();

			const mrs = await readSidecar<unknown[]>(
				bot.workRoot,
				"glab-mr-creates.json",
			);
			expect(mrs).toBeNull();
			// T04: worker 不再发送 escalation 通知（sidecar 为空）；
			// 主进程路由通知到达路由群。
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

	it("class 3 (code ≠ spec): → escalation, no MR", async () => {
		const bot = await setupBot({ CIHEAL_STUB_FIX_KIND: "class3-mismatch" });
		try {
			const { status } = await postWebhook(
				bot.base,
				pipelineFailedBody("proj-c3mismatch", 300_400, "main", "ddd4444444444444"),
			);
			expect(status).toBe(202);
			await bot.scheduler.idle();

			const mrs = await readSidecar<unknown[]>(
				bot.workRoot,
				"glab-mr-creates.json",
			);
			expect(mrs).toBeNull();
			// T04: worker 零 escalation 通知；主进程路由通知到达。
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

	it("class 4 (flaky): → escalation + DingTalk, no MR", async () => {
		const bot = await setupBot({ CIHEAL_STUB_FIX_KIND: "class4" });
		try {
			const { status } = await postWebhook(
				bot.base,
				pipelineFailedBody("proj-c4", 300_500, "main", "eee5555555555555"),
			);
			expect(status).toBe(202);
			await bot.scheduler.idle();

			const mrs = await readSidecar<unknown[]>(
				bot.workRoot,
				"glab-mr-creates.json",
			);
			expect(mrs).toBeNull();
			// T04: worker 零 escalation 通知；主进程路由通知到达。
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

	it("class 5 (compile error): → early-filter escalation, no agent spawned", async () => {
		// The early filter intercepts BEFORE the agent runs, so no MR and no
		// agent session. Budget is saved (the class-5 invariant).
		const bot = await setupBot({ CIHEAL_STUB_CI_LOG: "class5" });
		try {
			const { status } = await postWebhook(
				bot.base,
				pipelineFailedBody("proj-c5", 300_600, "main", "fff6666666666666"),
			);
			expect(status).toBe(202);
			await bot.scheduler.idle();

			// No MR created (class 5 never reaches the agent → no fix → no MR).
			const mrs = await readSidecar<unknown[]>(
				bot.workRoot,
				"glab-mr-creates.json",
			);
			expect(mrs).toBeNull();
			// T04: escalation 通知走主进程路由（worker sidecar 为空），内容含 class-5 原因。
			const workerSent = await readSidecar<Array<{ title: string }>>(
				bot.workRoot,
				"dingtalk-sent.json",
			);
			expect(workerSent).toBeNull();
			const routed = bot.escalations.sentGroups.map((g) => g.message);
			expect(routed.some((d) => d.title.includes("转交"))).toBe(true);
			expect(routed.some((d) => d.text.includes("class 5"))).toBe(true);
		} finally {
			await bot.cleanup();
		}
	});
});
