/**
 * End-to-end fixture test (ticket 04): two-layer verification + flaky @Skip.
 *
 * Two fixtures exercise the verification gate through the established seam
 * (webhook → MR / escalation → DingTalk):
 *   - all-green: two-layer verify (related then full regression) both pass →
 *     MR + success DingTalk. The stub verify runner records both layers ran.
 *   - flaky: full regression hits a flaky test. The stub agent marks @Skip on
 *     the flaky test file; the bot DISCARDS the @Skip edit (per design
 *     decision: discard + DingTalk only, no @Skip in any MR), sends an
 *     independent flaky DingTalk notification, and the repair MR stays clean
 *     (no @Skip in the MR diff).
 *
 * The WHY:
 *  - Two-layer verification catches regressions the related-only gate misses.
 *  - Flaky isolation keeps the repair MR reviewable (no unrelated @Skip noise)
 *    while still surfacing the flaky test to humans via a dedicated channel.
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

/** Set up an isolated bot instance (app + scheduler + worker manager). */
async function setupBot(env: Record<string, string>): Promise<{
	app: FastifyInstance;
	scheduler: Scheduler;
	base: string;
	workRoot: string;
	cleanup: () => Promise<void>;
}> {
	const workRoot = await mkdtemp(join(tmpdir(), "ciheal-verify-"));
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
		maxWorkers: 1,
		policy: CI_REPAIR_SCHEDULING_POLICY,
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

describe("verification two-layer + flaky @Skip (ticket 04)", () => {
	it("all-green: two-layer verify (related then full) both pass → MR + success DingTalk", async () => {
		const bot = await setupBot({
			CIHEAL_STUB_FIX_KIND: "class2",
			CIHEAL_STUB_VERIFY: "all-green",
		});
		try {
			const { status } = await postWebhook(
				bot.base,
				pipelineFailedBody("proj-vg", 400_100, "main", "aabb112233445566"),
			);
			expect(status).toBe(202);
			await bot.scheduler.idle();

			// MR created (two-layer verify both green → not blocked).
			const mrs = await readSidecar<Array<{ fixFiles: readonly string[] }>>(
				bot.workRoot,
				"glab-mr-creates.json",
			);
			expect(mrs).not.toBeNull();
			expect(mrs!.length).toBe(1);

			// Verify runner recorded BOTH layers ran (related + full regression).
			const verifyCalls = await readSidecar<
				Array<{ layer: string; status: string }>
			>(bot.workRoot, "verify-calls.json");
			expect(verifyCalls).not.toBeNull();
			const layers = verifyCalls!.map((c) => c.layer);
			expect(layers).toContain("related");
			expect(layers).toContain("full");

			// Success DingTalk (not escalation).
			const dingtalk = await readSidecar<Array<{ title: string }>>(
				bot.workRoot,
				"dingtalk-sent.json",
			);
			expect(dingtalk).not.toBeNull();
			expect(dingtalk!.some((d) => d.title.includes("成功"))).toBe(true);
		} finally {
			await bot.cleanup();
		}
	});

	it("flaky: full regression hits flaky → @Skip discarded + independent flaky DingTalk + clean MR", async () => {
		const bot = await setupBot({
			CIHEAL_STUB_FIX_KIND: "class2",
			CIHEAL_STUB_VERIFY: "flaky",
		});
		try {
			const { status } = await postWebhook(
				bot.base,
				pipelineFailedBody("proj-vf", 400_200, "main", "ccdd223344551166"),
			);
			expect(status).toBe(202);
			await bot.scheduler.idle();

			// Repair MR still created (flaky doesn't block the fix).
			const mrs = await readSidecar<Array<{ fixFiles: readonly string[] }>>(
				bot.workRoot,
				"glab-mr-creates.json",
			);
			expect(mrs).not.toBeNull();
			expect(mrs!.length).toBe(1);

			// The @Disabled FlakyTest.java was discarded (reverted to HEAD) — it
			// must NOT appear in the MR patch. The fix files (CalculatorTest +
			// docs/api.md from class2 stub) must be preserved.
			const fixFiles = mrs![0].fixFiles;
			expect(fixFiles.some((f) => f.includes("FlakyTest"))).toBe(false);
			expect(fixFiles.some((f) => f.includes("CalculatorTest"))).toBe(true);
			expect(fixFiles.some((f) => f.startsWith("docs/"))).toBe(true);

			// MR diff is clean: no @Skip / @Disabled in the fix file paths.
			for (const f of fixFiles) {
				expect(f).not.toMatch(/@Skip|@Disabled/);
			}

			// Independent flaky DingTalk notification sent (separate from the
			// repair success notification).
			const dingtalk = await readSidecar<
				Array<{ title: string; text: string }>
			>(bot.workRoot, "dingtalk-sent.json");
			expect(dingtalk).not.toBeNull();
			// Both a success (repair) and a flaky notification.
			expect(dingtalk!.some((d) => d.title.includes("成功"))).toBe(true);
			expect(dingtalk!.some((d) => d.title.includes("flaky"))).toBe(true);
			// The flaky notification is distinct from the success notification.
			const flakyMsg = dingtalk!.filter((d) => d.title.includes("flaky"));
			expect(flakyMsg.length).toBeGreaterThanOrEqual(1);
		} finally {
			await bot.cleanup();
		}
	});
});
