/**
 * E2E acceptance gate for Ticket 06 — running-worker supersede steer.
 *
 * WHY: While agent repairs an MR, newer pushes must steer the live session
 * with the latest sha (merged during the undelivered window), not queue silent
 * stale repairs.
 */

import { describe, it, expect, afterEach } from "vitest";
import Fastify from "fastify";
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { Scheduler } from "../../src/agent-runtime/scheduler.js";
import { CI_REPAIR_SCHEDULING_POLICY } from "../../src/agent/ci-repair-definition.js";
import { SubprocessWorkerManager } from "../../src/worker/manager.js";
import { mountWebhook, type WebhookConfig } from "../../src/webhook/receiver.js";
import { isWorkerIpcMessage } from "../../src/dashboard/ipc-types.js";

const PROJECT = "proj-supersede-steer";
const MR_IID = 77;

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
		merge_request: { source_branch: "feature/supersede", iid: MR_IID },
		project: {
			id: PROJECT,
			web_url: `https://gitlab.example.com/${PROJECT}`,
		},
	};
}

function findSteersFiles(root: string): string[] {
	const found: string[] = [];
	const walk = (dir: string) => {
		for (const name of readdirSync(dir)) {
			const path = join(dir, name);
			const st = statSync(path);
			if (st.isDirectory()) walk(path);
			else if (name === "steers.json") found.push(path);
		}
	};
	if (existsSync(root)) walk(root);
	return found;
}

const roots: string[] = [];
afterEach(() => {
	for (const root of roots.splice(0)) {
		rmSync(root, { recursive: true, force: true });
	}
});

describe("supersede steer e2e (Ticket 06)", () => {
	it("运行中三连推送 → stub session 恰收到 1 条含最终 sha 的 steer", async () => {
		const root = mkdtempSync(join(tmpdir(), "supersede-steer-e2e-"));
		roots.push(root);
		const dataRoot = join(root, "data");
		const workRoot = join(root, "work");
		const lifecycle: Array<{ type: string; data: Record<string, unknown> }> = [];

		let scheduler!: Scheduler;
		const manager = new SubprocessWorkerManager({
			timeoutMs: 60_000,
			keepWork: true,
			onIpcMessage: (event, msg) => {
				if (!isWorkerIpcMessage(msg)) return;
				if (msg.type === "steer_delivered") {
					scheduler.onSteerDelivered(CI_REPAIR_SCHEDULING_POLICY.serialKey(event));
				}
			},
			env: {
				CIHEAL_GLAB_MODE: "fake",
				CIHEAL_DINGTALK_MODE: "fake",
				CIHEAL_WORKTREE_MODE: "fake",
				CIHEAL_DATA_ROOT: dataRoot,
				CIHEAL_BOT_ROOT: process.cwd(),
				CIHEAL_PI_BASE_DIR: "",
				CIHEAL_AGENT_MODE: "real",
				CIHEAL_SESSION_FACTORY: "stub",
				CIHEAL_STUB_DELAY_MS: "2000",
				CIHEAL_STUB_MR_STATUS: "success",
			},
		});

		scheduler = new Scheduler({
			workerManager: manager,
			workRoot,
			policy: CI_REPAIR_SCHEDULING_POLICY,
			maxWorkers: 1,
			onLifecycleEvent: (type, data) => lifecycle.push({ type, data }),
		});

		const app = Fastify();
		await mountWebhook(app, { scheduler, config: webhookConfig });

		async function inject(payload: Record<string, unknown>) {
			const res = await app.inject({
				method: "POST",
				url: "/webhook/gitlab?repair=1",
				headers: { "x-gitlab-token": "secret" },
				payload,
			});
			return res.statusCode;
		}

		expect(await inject(pipelinePayload({ pipelineId: 5001, sha: "sha0000000001" }))).toBe(202);
		while (!lifecycle.some((e) => e.type === "worker_started")) {
			await new Promise((r) => setTimeout(r, 20));
		}
		await new Promise((r) => setTimeout(r, 100));

		expect(await inject(pipelinePayload({ pipelineId: 5002, sha: "sha0000000002" }))).toBe(202);
		expect(await inject(pipelinePayload({ pipelineId: 5003, sha: "sha0000000003" }))).toBe(202);

		expect(lifecycle.some((e) => e.type === "pipeline_supersede_steer")).toBe(true);
		expect(lifecycle.some((e) => e.type === "steer_merged")).toBe(true);

		await scheduler.idle();
		await app.close();

		const steerFiles = findSteersFiles(workRoot);
		expect(steerFiles.length).toBeGreaterThan(0);
		const steers = JSON.parse(readFileSync(steerFiles[0]!, "utf8")) as string[];
		expect(steers).toHaveLength(1);
		expect(steers[0]).toContain("sha0000000003");
		expect(steers[0]).toContain("sha0000000001");
	}, 90_000);
});
