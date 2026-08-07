/**
 * End-to-end fixture test (ticket 07): worker-crash self-fault DingTalk alert.
 *
 * G7: when the bot detects repeated worker crashes (worker全死 — the bot
 * can't repair anything if every worker dies), it fires a DingTalk alert so
 * an operator intervenes. This is a code-detectable self-fault; webhook
 * unreachability is deployment-level (external probe) and not asserted here.
 *
 * The WHY:
 *  - A single worker crash is transient (the next event may succeed). But N
 *    consecutive crashes means the bot is broken — continuing to enqueue only
 *    burns resources. The alert surfaces "the bot is down" before operators
 *    notice via silent failure (no MRs appearing).
 *  - Quota-exhaustion alerts already exist (ticket 02 budget breach); this
 *    covers the other code-detectable self-fault: the worker layer itself.
 */

import { describe, it, expect } from "vitest";
import Fastify, { type FastifyInstance } from "fastify";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Scheduler } from "../../src/agent-runtime/scheduler.js";
import { CI_REPAIR_SCHEDULING_POLICY } from "../../src/agent/ci-repair-definition.js";
import { mountWebhook } from "../../src/webhook/receiver.js";
import { InMemoryDingTalkNotifier } from "../../src/notify/dingtalk.js";

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

async function setupBot(opts: {
	threshold?: number;
	workerError?: string;
}): Promise<{
	app: FastifyInstance;
	scheduler: Scheduler;
	base: string;
	notifier: InMemoryDingTalkNotifier;
	cleanup: () => Promise<void>;
}> {
	const workRoot = await mkdtemp(join(tmpdir(), "ciheal-crash-"));
	// A worker manager whose `run` always rejects — simulates worker全死
	// (e.g. the worker binary is broken, or the runtime is missing).
	const crashManager = {
		run(): Promise<never> {
			return Promise.reject(
				new Error(opts.workerError ?? "worker subprocess crashed"),
			);
		},
	};
	const notifier = new InMemoryDingTalkNotifier();
	const scheduler = new Scheduler({
		workerManager: crashManager,
		workRoot,
		maxWorkers: 1,
		policy: CI_REPAIR_SCHEDULING_POLICY,
		notifier,
		workerCrashThreshold: opts.threshold ?? 3,
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
		notifier,
		cleanup: async () => {
			await app.close();
			await rm(workRoot, { recursive: true, force: true }).catch(() => {});
		},
	};
}

describe("worker-crash self-fault alert (ticket 07)", () => {
	it("N consecutive worker crashes fire a DingTalk self-fault alert", async () => {
		const bot = await setupBot({ threshold: 3 });
		try {
			// Fire 3 events — each worker crashes. The 3rd triggers the alert.
			for (let i = 1; i <= 3; i++) {
				await postWebhook(
					bot.base,
					pipelineFailedBody(
						`proj-crash`,
						950_000 + i,
						"main",
						`${i}`.repeat(16),
					),
				);
			}
			await bot.scheduler.idle();

			// The self-fault alert fired (bot is down — operator must intervene).
			expect(bot.notifier.sent.length).toBeGreaterThanOrEqual(1);
			const alert = bot.notifier.sent.find((m) => m.title.includes("自故障"));
			expect(alert).toBeTruthy();
			expect(alert!.text).toContain("worker");
		} finally {
			await bot.cleanup();
		}
	});

	it("does not expose worker error details in the DingTalk alert", async () => {
		const bot = await setupBot({
			threshold: 1,
			workerError: "provider failed: token=leaked-secret",
		});
		try {
			await postWebhook(
				bot.base,
				pipelineFailedBody("proj-crash-secret", 950_100),
			);
			await bot.scheduler.idle();

			const alert = bot.notifier.sent.find((m) => m.title.includes("自故障"));
			expect(alert).toBeTruthy();
			expect(alert!.text).not.toContain("leaked-secret");
		} finally {
			await bot.cleanup();
		}
	});

	it("below threshold: no self-fault alert (single crash is transient)", async () => {
		const bot = await setupBot({ threshold: 3 });
		try {
			await postWebhook(
				bot.base,
				pipelineFailedBody("proj-crash-1", 951_001, "main", "1".repeat(16)),
			);
			await bot.scheduler.idle();

			// One crash — no alert yet (transient, the bot may recover).
			const selfFault = bot.notifier.sent.filter((m) =>
				m.title.includes("自故障"),
			);
			expect(selfFault.length).toBe(0);
		} finally {
			await bot.cleanup();
		}
	});

	it("a successful repair after crashes resets the crash counter (no false alert)", async () => {
		const workRoot = await mkdtemp(join(tmpdir(), "ciheal-crash-reset-"));
		// A manager that crashes twice then succeeds (stateful stub).
		let callCount = 0;
		const flakyManager = {
			run(_event: { projectId: string; pipelineId: number }, _cwd: string) {
				callCount++;
				if (callCount <= 2) {
					return Promise.reject(new Error("transient crash"));
				}
				return Promise.resolve({
					kind: "escalated" as const,
					summary: "recovered",
				});
			},
		};
		const notifier = new InMemoryDingTalkNotifier();
		const scheduler = new Scheduler({
			workerManager: flakyManager,
			workRoot,
			maxWorkers: 1,
			policy: CI_REPAIR_SCHEDULING_POLICY,
			notifier,
			workerCrashThreshold: 3,
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
		try {
			// 2 crashes (below threshold), then a success, then 1 more crash.
			// Counter reset by success → no alert (only 1 crash after reset).
			for (let i = 1; i <= 3; i++) {
				await postWebhook(
					base,
					pipelineFailedBody(
						"proj-reset",
						952_000 + i,
						"main",
						`${i}`.repeat(16),
					),
				);
				await scheduler.idle();
			}
			const selfFault = notifier.sent.filter((m) => m.title.includes("自故障"));
			expect(selfFault.length).toBe(0);
		} finally {
			await app.close();
			await rm(workRoot, { recursive: true, force: true }).catch(() => {});
		}
	});
});
