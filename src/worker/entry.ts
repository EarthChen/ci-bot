/**
 * Worker entry — run inside a spawned subprocess (one per pipeline event).
 *
 * Per-worker isolation (G4): each worker gets its own cwd + session dir + env.
 * The worker runs the full G2 pipeline for one event:
 *   fetch CI log → class-5 early filter → run agent → create MR → notify DingTalk → write outcome.
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
import type { Patch } from "../types.js";
import { logger } from "../util/log.js";
import { runRepair, type WorkerDeps, type TestRunner, type TestRunResult } from "../pipeline/run-repair.js";

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
		const totalLimit =
			Number(process.env.BOT_BUDGET_TOKENS ?? "200000") || 200_000;
		const perTurnLimit =
			Number(process.env.BOT_BUDGET_PER_TURN_TOKENS ?? "50000") || 50_000;
		// CIHEAL_SESSION_FACTORY=stub → e2e fixture: drive the real runner path
		// (budget/parse/G3/MR/DingTalk) with a canned-result stub session, no LLM.
		const factory =
			process.env.CIHEAL_SESSION_FACTORY === "stub"
				? stubSessionFactory
				: undefined;
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

/** Pick the verification runner. CIHEAL_STUB_VERIFY controls fixture behavior. */
function pickVerify(cwd: string): TestRunner | undefined {
	const mode = process.env.CIHEAL_STUB_VERIFY;
	if (!mode) return undefined; // production default: MvnGradleTestRunner
	return new StubVerifyRunner(cwd, mode);
}

function pickDingTalk(cwd: string): DingTalkNotifier {
	const mode = process.env.CIHEAL_DINGTALK_MODE ?? "fake";
	if (mode === "fake") return makeFakeDingtalk(cwd);
	if (mode === "real") {
		const webhookUrl = process.env.DINGTALK_WEBHOOK_URL;
		if (!webhookUrl)
			throw new Error(
				"DINGTALK_WEBHOOK_URL required when CIHEAL_DINGTALK_MODE=real",
			);
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
			// CIHEAL_STUB_CI_LOG controls the canned CI log shape.
			//   "class5" — a compile/dependency failure log (triggers class-5 early filter)
			//   default  — a class-1 assertion failure log
			const logKind = process.env.CIHEAL_STUB_CI_LOG ?? "class1";
			if (logKind === "class5") {
				return [
								"Running build...",
								"[ERROR] Compilation failure:",
								"[ERROR] /src/main/java/com/example/Calculator.java:[10,20] cannot find symbol",
								"BUILD FAILURE",
				].join("\n");
			}
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

/**
 * Stub verify runner for e2e fixtures. CIHEAL_STUB_VERIFY controls behavior:
 *   "all-green" — both layers green, records calls to verify-calls.json sidecar
 *   "flaky"     — related green, full flaky; simulates agent @Skip on FlakyTest
 *
 * Records each layer call to verify-calls.json so the test can assert both
 * layers ran (the two-layer invariant).
 */
class StubVerifyRunner implements TestRunner {
	private readonly cwd: string;
	private readonly mode: string;
	constructor(cwd: string, mode: string) {
		this.cwd = cwd;
		this.mode = mode;
	}
	async runRelated(_cwd: string, _patch: Patch): Promise<TestRunResult> {
		await this.record("related", "green");
		return { status: "green" };
	}
	async runFull(_cwd: string): Promise<TestRunResult> {
		if (this.mode === "flaky") {
			// Simulate the agent having marked @Skip on FlakyTest.java during its
			// session. The bot's discardSkipEdits will revert it.
			await this.writeSkipAnnotation();
			await this.record("full", "flaky");
			return { status: "flaky", flakyTests: ["src/test/java/com/example/FlakyTest.java"] };
		}
		await this.record("full", "green");
		return { status: "green" };
	}
	private async record(layer: string, status: string): Promise<void> {
		const file = joinPath(this.cwd, "verify-calls.json");
		let calls: Array<{ layer: string; status: string }> = [];
		try {
			const raw = await import("node:fs").then((m) => m.readFileSync(file, "utf8"));
			calls = JSON.parse(raw) as typeof calls;
		} catch {
			void 0; // first call — file doesn't exist yet
		}
		calls.push({ layer, status });
		await writeJSON(file, calls);
	}
	/** Write a @Skip annotation to FlakyTest.java (simulates agent behavior). */
	private async writeSkipAnnotation(): Promise<void> {
		const { mkdirSync, writeFileSync } = await import("node:fs");
		const path = joinPath(this.cwd, "src/test/java/com/example/FlakyTest.java");
		mkdirSync(dirname(path), { recursive: true });
		writeFileSync(
			path,
			"package com.example;\nimport org.junit.jupiter.api.Disabled;\n@Disabled\npublic class FlakyTest {}\n",
			"utf8",
		);
	}
}

export async function runWorker(task: WorkerTask): Promise<RepairOutcome> {
	const dingtalk = pickDingTalk(task.cwd);
	const agent = pickAgent(dingtalk);
	const glab = pickGlab(task.cwd);
	const verifyRunner = pickVerify(task.cwd);
	const deps: WorkerDeps = { agent, glab, dingtalk, cwd: task.cwd, verifyRunner };
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
