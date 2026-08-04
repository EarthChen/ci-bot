/**
 * Worker entry — run inside a spawned subprocess (one per pipeline event).
 *
 * Per-worker isolation (G4): each worker gets its own cwd + session dir + env.
 * The worker runs the full G2 pipeline for one event:
 *   fetch CI log → (class 5 early-filter TODO in ticket 03) → run agent →
 *   create MR → notify DingTalk → write outcome.
 *
 * Dependency injection via env switches lets the e2e test drive a REAL
 * subprocess while intercepting external side effects (glab/dingtalk/agent):
 *
 *   CIHEAL_AGENT_MODE=stub|real   (stub = canned result; real = pi SDK session)
 *   CIHEAL_GLAB_MODE=fake|real
 *   CIHEAL_DINGTALK_MODE=fake|real
 *   CIHEAL_RESULT_FILE=<path>      (worker writes its RepairOutcome JSON here)
 *
 * The task (PipelineEvent + cwd + ref + sha) arrives as JSON in
 * CIHEAL_WORKER_TASK.
 */

import { writeFileSync, mkdirSync } from "node:fs";
import { dirname, join as joinPath } from "node:path";
import type { AgentRunner } from "../agent/runner.js";
import { StubAgentRunner } from "../agent/runner.js";
import { RealAgentRunner } from "../agent/real-runner.js";
import { stubSessionFactory } from "../agent/stub-session.js";
import type { GitLabClient } from "../gitlab/glab-client.js";
import { GlabGitLabClient } from "../gitlab/glab-client.js";
import type { DingTalkNotifier } from "../notify/dingtalk.js";
import { HttpDingTalkNotifier } from "../notify/dingtalk.js";
import type { PipelineEvent, RepairOutcome } from "../types.js";
import { logger } from "../util/log.js";
import { runRepair, type WorkerDeps } from "../pipeline/run-repair.js";

/** Write JSON to a path, creating parent dirs (best-effort, never throws in caller). */
async function writeJSON(path: string, value: unknown): Promise<void> {
	try {
		mkdirSync(dirname(path), { recursive: true });
		writeFileSync(path, JSON.stringify(value, null, 2), "utf8");
	} catch (err) {
		logger.warn({ path, err }, "failed to write fake sidecar");
	}
}

/** Input shape passed via CIHEAL_WORKER_TASK. */
export interface WorkerTask {
	readonly event: PipelineEvent;
	readonly cwd: string;
}

function pickAgent(dingtalk: DingTalkNotifier): AgentRunner {
	const mode = process.env.CIHEAL_AGENT_MODE ?? "stub";
	if (mode === "stub") return new StubAgentRunner();
	if (mode === "real") {
		const totalLimit = Number(process.env.BOT_BUDGET_TOKENS ?? "200000") || 200_000;
		const perTurnLimit = Number(process.env.BOT_BUDGET_PER_TURN_TOKENS ?? "50000") || 50_000;
		// CIHEAL_SESSION_FACTORY=stub → e2e fixture: drive the real runner path
		// (budget/parse/G3/MR/DingTalk) with a canned-result stub session, no LLM.
		const factory = process.env.CIHEAL_SESSION_FACTORY === "stub" ? stubSessionFactory : undefined;
		return new RealAgentRunner({
			sessionFactory: factory,
			dingtalk,
			budget: { totalTokenLimit: totalLimit, perTurnTokenLimit: perTurnLimit },
		});
	}
	throw new Error(`CIHEAL_AGENT_MODE=${mode} not supported`);
}

function pickGlab(cwd: string): GitLabClient {
	const mode = process.env.CIHEAL_GLAB_MODE ?? "fake";
	if (mode === "fake") return makeFakeGlab(cwd);
	return new GlabGitLabClient(realGlabRunner);
}

function pickDingTalk(cwd: string): DingTalkNotifier {
	const mode = process.env.CIHEAL_DINGTALK_MODE ?? "fake";
	if (mode === "fake") return makeFakeDingtalk(cwd);
	if (mode === "real") {
		const webhookUrl = process.env.DINGTALK_WEBHOOK_URL;
		if (!webhookUrl) throw new Error("DINGTALK_WEBHOOK_URL required when CIHEAL_DINGTALK_MODE=real");
		return new HttpDingTalkNotifier(webhookUrl, realDingTalkPost);
	}
	throw new Error(`CIHEAL_DINGTALK_MODE=${mode} not supported`);
}

async function realDingTalkPost(url: string, body: unknown): Promise<void> {
	const res = await fetch(url, {
		method: "POST",
		headers: { "content-type": "application/json" },
		body: JSON.stringify(body),
	});
	if (!res.ok) {
		throw new Error(`dingtalk webhook failed: ${res.status} ${res.statusText}`);
	}
}

async function realGlabRunner(args: readonly string[]): Promise<string> {
	const { execFile } = await import("node:child_process");
	const { promisify } = await import("node:util");
	const execFileP = promisify(execFile);
	const { stdout } = await execFileP("glab", args as string[], {
		env: { ...process.env, GITLAB_HOST: process.env.GITLAB_URL ?? "" },
	});
	return stdout;
}

/**
 * Fake glab used by the e2e test (and dry-run). Returns a canned CI log
 * signaling a class-1 assertion failure, and records `mr create` calls.
 *
 * NOTE: Real subprocess + fake deps — the seam under test is the bot's own
 * orchestration (spawn/queue/webhook), not whether glab actually runs.
 */
export interface FakeGlabRecorder {
	readonly createdMrs: Array<{
		projectId: string;
		sourceBranch: string;
		targetBranch: string;
		title: string;
		body: string;
		diagnosis: { failureClass: number; summary: string };
		fixFiles: readonly string[];
	}>;
}

function makeFakeGlab(cwd: string): GitLabClient & FakeGlabRecorder {
	const createdMrs: FakeGlabRecorder["createdMrs"] = [];
	const client: GitLabClient & FakeGlabRecorder = {
		createdMrs,
		async fetchCiLog(): Promise<string> {
			return [
				"Running com.example.CalculatorTest",
				"  CalculatorTest.addsTwoPlusThree()",
				"  expected: <4> but was: <5>",
				"BUILD FAILURE: tests failed",
			].join("\n");
		},
		async fetchMrDiff(): Promise<string> {
			return "";
		},
		async createMr(params): Promise<{ url: string }> {
			const rec = {
				projectId: params.projectId,
				sourceBranch: params.sourceBranch,
				targetBranch: params.targetBranch,
				title: params.title,
				body: params.patch.summary,
				diagnosis: params.diagnosis,
				fixFiles: params.patch.paths,
			};
			createdMrs.push(rec);
			// Persist to cwd so the parent test can observe across the process seam.
			await writeJSON(joinPath(cwd, "glab-mr-creates.json"), createdMrs);
			return {
				url: `https://gitlab.example.com/fake/-/merge_requests/${createdMrs.length}`,
			};
		},
	};
	return client;
}

function makeFakeDingtalk(cwd: string): DingTalkNotifier & { sent: unknown[] } {
	const sent: unknown[] = [];
	return {
		sent,
		async send(message) {
			sent.push(message);
			await writeJSON(joinPath(cwd, "dingtalk-sent.json"), sent);
		},
	};
}

export async function runWorker(task: WorkerTask): Promise<RepairOutcome> {
	const dingtalk = pickDingTalk(task.cwd);
	const agent = pickAgent(dingtalk);
	const glab = pickGlab(task.cwd);
	const deps: WorkerDeps = { agent, glab, dingtalk, cwd: task.cwd };
	return runRepair(deps, task.event);
}

/** Entry point invoked by the worker manager subprocess. */
export async function main(): Promise<void> {
	const taskJson = process.env.CIHEAL_WORKER_TASK;
	if (!taskJson) throw new Error("CIHEAL_WORKER_TASK not set");
	let task: WorkerTask;
	try {
		task = JSON.parse(taskJson) as WorkerTask;
	} catch (err) {
		throw new Error(
			`invalid CIHEAL_WORKER_TASK JSON: ${err instanceof Error ? err.message : err}`,
		);
	}

	// Make the fake recorders observable by the test via env (if present).
	const result = await runWorker(task);
	const resultFile = process.env.CIHEAL_RESULT_FILE;
	if (resultFile) {
		mkdirSync(dirname(resultFile), { recursive: true });
		writeFileSync(resultFile, JSON.stringify(result, null, 2), "utf8");
	}
	logger.info({ result }, "worker finished");
}

// Re-export for the e2e test to read fake recorder state when in-process.
export { StubAgentRunner };
