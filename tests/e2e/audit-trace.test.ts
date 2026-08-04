/**
 * End-to-end fixture test (ticket 06): LLM audit archive.
 *
 * Every repair (fixed → MR or escalated) must persist an audit-trace.json
 * sidecar in the worker cwd so a bad fix can be traced back afterward. The
 * audit record captures WHAT changed (diff), WHY (diagnosis + reasoning),
 * and the outcome (MR url or escalation reason) — the post-hoc traceability
 * invariant from G5.
 *
 * Tokens are deliberately NOT asserted here — ticket 07 (observability) owns
 * the per-repair trace (turns/tokens/cost). This test owns the G5 audit
 * invariant: diff + diagnosis + reasoning + outcome are durably recorded.
 *
 * The WHY:
 *  - A reviewer merging an MR can't always tell from the diff alone whether
 *    the bot's reasoning was sound. The audit sidecar preserves the LLM's
 *    diagnosis + reasoning so a later post-mortem can tell "fix was wrong
 *    because the diagnosis misclassified class 2 as class 1."
 *  - Without this, a bad fix lands and there is no durable record of the
 *    bot's reasoning to improve the playbook against.
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
		project: {
			id: projectId,
			web_url: `https://gitlab.example.com/${projectId}`,
		},
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

/** The audit record shape the worker must persist per repair. */
interface AuditTrace {
	readonly event: {
		readonly projectId: string;
		readonly pipelineId: number;
		readonly ref: string;
		readonly sha: string;
	};
	readonly outcome: string;
	readonly diagnosis: {
		readonly failureClass: number;
		readonly summary: string;
	};
	readonly diff: string;
	readonly reasoning: string;
	readonly mrUrl?: string;
	readonly createdAt: string;
}

async function setupBot(env: Record<string, string>): Promise<{
	app: FastifyInstance;
	scheduler: Scheduler;
	base: string;
	workRoot: string;
	cleanup: () => Promise<void>;
}> {
	const workRoot = await mkdtemp(join(tmpdir(), "ciheal-audit-"));
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

describe("LLM audit archive (ticket 06)", () => {
	it("fixed → MR: persists audit-trace.json with diff + diagnosis + reasoning + mrUrl", async () => {
		const bot = await setupBot({ CIHEAL_STUB_FIX_KIND: "class2" });
		try {
			const { status } = await postWebhook(
				bot.base,
				pipelineFailedBody("proj-aud-mr", 600_100, "main", "a1b2c3d4e5f6a7b8"),
			);
			expect(status).toBe(202);
			await bot.scheduler.idle();

			const audit = await readSidecar<AuditTrace>(
				bot.workRoot,
				"audit-trace.json",
			);
			// The audit sidecar exists (the traceability invariant).
			expect(audit).not.toBeNull();

			// Event identity is fully recorded (so a trace ties back to a pipeline).
			expect(audit!.event.projectId).toBe("proj-aud-mr");
			expect(audit!.event.pipelineId).toBe(600_100);
			expect(audit!.event.ref).toBe("main");
			expect(audit!.event.sha).toBe("a1b2c3d4e5f6a7b8");

			// Outcome is recorded (MR branch).
			expect(audit!.outcome).toBe("mr");

			// Diagnosis (the LLM's classification + root-cause summary) is recorded
			// so a post-mortem can tell "misclassified class 2 as class 1."
			expect(audit!.diagnosis.failureClass).toBe(2);
			expect(audit!.diagnosis.summary).toBeTruthy();

			// The real git diff is archived (authoritative — not the agent's
			// self-reported content). Must be non-empty for a fixed repair.
			expect(audit!.diff.length).toBeGreaterThan(0);

			// Reasoning (the bot's recorded rationale for the fix) is archived.
			expect(audit!.reasoning).toBeTruthy();

			// MR url is recorded so the trace links to the human review artifact.
			expect(audit!.mrUrl).toBeTruthy();

			// Timestamp for audit ordering / retention.
			expect(audit!.createdAt).toBeTruthy();
		} finally {
			await bot.cleanup();
		}
	});

	it("escalated: persists audit-trace.json with outcome + diagnosis + reasoning, no mrUrl", async () => {
		const bot = await setupBot({ CIHEAL_STUB_FIX_KIND: "class3-no-spec" });
		try {
			const { status } = await postWebhook(
				bot.base,
				pipelineFailedBody("proj-aud-esc", 600_200, "main", "b2c3d4e5f6a7b8c9"),
			);
			expect(status).toBe(202);
			await bot.scheduler.idle();

			const audit = await readSidecar<AuditTrace>(
				bot.workRoot,
				"audit-trace.json",
			);
			expect(audit).not.toBeNull();

			expect(audit!.event.projectId).toBe("proj-aud-esc");
			expect(audit!.event.pipelineId).toBe(600_200);

			// Outcome is escalated (no MR created).
			expect(audit!.outcome).toBe("escalated");

			// Diagnosis still recorded (escalations carry a class + reason).
			expect(audit!.diagnosis.failureClass).toBe(3);
			expect(audit!.diagnosis.summary).toBeTruthy();

			// Reasoning carries the escalation rationale.
			expect(audit!.reasoning).toBeTruthy();

			// No MR url on an escalation.
			expect(audit!.mrUrl).toBeUndefined();

			// Diff is empty for an escalation (no patch was produced).
			expect(audit!.diff).toBe("");
		} finally {
			await bot.cleanup();
		}
	});

	it("class 5 early-filter escalation: persists audit-trace.json (budget saved, still auditable)", async () => {
		// The class-5 path skips the agent entirely. The audit must still record
		// the event + outcome + reasoning so a later trace explains "why was no
		// agent run on pipeline X" — the traceability invariant holds even when
		// the bot short-circuits.
		const bot = await setupBot({ CIHEAL_STUB_CI_LOG: "class5" });
		try {
			const { status } = await postWebhook(
				bot.base,
				pipelineFailedBody("proj-aud-c5", 600_300, "main", "c3d4e5f6a7b8c9d0"),
			);
			expect(status).toBe(202);
			await bot.scheduler.idle();

			const audit = await readSidecar<AuditTrace>(
				bot.workRoot,
				"audit-trace.json",
			);
			expect(audit).not.toBeNull();
			expect(audit!.event.projectId).toBe("proj-aud-c5");
			expect(audit!.outcome).toBe("escalated");
			expect(audit!.reasoning).toContain("class 5");
			// No agent ran → no diff, no LLM diagnosis class.
			expect(audit!.diff).toBe("");
		} finally {
			await bot.cleanup();
		}
	});
});
