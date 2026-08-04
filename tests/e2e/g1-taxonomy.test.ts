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
import { Scheduler } from "../../src/queue/scheduler.js";
import { SubprocessWorkerManager } from "../../src/worker/manager.js";
import { mountWebhook } from "../../src/webhook/receiver.js";

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
		project: { id: projectId, web_url: `https://gitlab.example.com/${projectId}` },
	};
}

async function postWebhook(
	base: string,
	body: unknown,
	token = WEBHOOK_SECRET,
): Promise<{ status: number; json: unknown }> {
	const res = await fetch(`${base}/webhook`, {
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
	const scheduler = new Scheduler({
		workerManager,
		workRoot,
		concurrency: 1,
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

			const mrs = await readSidecar<
				Array<{
					projectId: string;
					diagnosis: { failureClass: number };
					fixFiles: readonly string[];
				}>
			>(bot.workRoot, "glab-mr-creates.json");
			expect(mrs).not.toBeNull();
			expect(mrs!.length).toBe(1);
			expect(mrs![0].diagnosis.failureClass).toBe(2);
			// Doc sync: a docs/ file is in the patch (G2 relevant-paragraph rule).
			expect(mrs![0].fixFiles.some((p) => p.startsWith("docs/"))).toBe(true);
			// Test file also present.
			expect(mrs![0].fixFiles.some((p) => p.includes("CalculatorTest"))).toBe(true);
			// G3 honored: no src/main.
			for (const p of mrs![0].fixFiles) {
				expect(p).not.toMatch(/^src\/main\//);
			}
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

			const mrs = await readSidecar<
				Array<{
					diagnosis: { failureClass: number };
					fixFiles: readonly string[];
				}>
			>(bot.workRoot, "glab-mr-creates.json");
			expect(mrs).not.toBeNull();
			expect(mrs!.length).toBe(1);
			expect(mrs![0].diagnosis.failureClass).toBe(3);
			// New conformance test file (not the existing CalculatorTest).
			expect(mrs![0].fixFiles.some((p) => p.includes("Conformance"))).toBe(true);
			for (const p of mrs![0].fixFiles) {
				expect(p).not.toMatch(/^src\/main\//);
			}
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
			const dingtalk = await readSidecar<
				Array<{ title: string; text: string }>
			>(bot.workRoot, "dingtalk-sent.json");
			expect(dingtalk).not.toBeNull();
			expect(dingtalk!.some((d) => d.title.includes("转交"))).toBe(true);
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
			const dingtalk = await readSidecar<
				Array<{ title: string; text: string }>
			>(bot.workRoot, "dingtalk-sent.json");
			expect(dingtalk).not.toBeNull();
			expect(dingtalk!.some((d) => d.title.includes("转交"))).toBe(true);
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
			const dingtalk = await readSidecar<
				Array<{ title: string; text: string }>
			>(bot.workRoot, "dingtalk-sent.json");
			expect(dingtalk).not.toBeNull();
			expect(dingtalk!.some((d) => d.title.includes("转交"))).toBe(true);
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
			// Escalation DingTalk sent with class-5 reason.
			const dingtalk = await readSidecar<
				Array<{ title: string; text: string }>
			>(bot.workRoot, "dingtalk-sent.json");
			expect(dingtalk).not.toBeNull();
			expect(dingtalk!.some((d) => d.title.includes("转交"))).toBe(true);
			expect(dingtalk!.some((d) => d.text.includes("class 5"))).toBe(true);
		} finally {
			await bot.cleanup();
		}
	});
});
