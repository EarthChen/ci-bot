/**
 * Agent runner — the seam between bot code and the LLM agent.
 *
 * Ticket 01: a STUB runner that returns a canned class-1 diagnosis + fix.
 * Ticket 02 swaps this for a real pi SDK `createAgentSession` call.
 *
 * Per G2: the agent session runs diagnosis → fix → (doc sync) in one
 * continuous session and outputs a structured result. The agent NEVER holds
 * the DingTalk tool — only bot code notifies.
 */

import type { AgentResult, Diagnosis } from "../types.js";
import { writeFileSync, mkdirSync } from "node:fs";
import { dirname, join as joinPath } from "node:path";

export interface AgentRunInput {
	/** Project id from the pipeline event. */
	readonly projectId: string;
	/** Pipeline id (for traceability). */
	readonly pipelineId: number;
	/** Ref + sha being repaired. */
	readonly ref: string;
	readonly sha: string;
	/** Aggregated CI log text. */
	readonly ciLog: string;
	/** MR diff if a related MR exists (empty if none). */
	readonly mrDiff: string;
	/** Repo working directory (cwd isolation per worker). */
	readonly cwd: string;
	/** MR source branch agent should push to (ci-self-heal/<ref>-<sha8>). */
	readonly sourceBranch: string;
	/** MR target branch (the pipeline's ref). */
	readonly targetBranch: string;
}

/** Human decision slice handed to a resume run (T06). */
export interface ResumeDecision {
	readonly value: "test";
	readonly remark: string;
}

export interface AgentRunner {
	/** Run one agent session. Returns the structured outcome. */
	run(input: AgentRunInput): Promise<AgentResult>;
	/**
	 * Continue an in-flight repair after its MR's CI failed: re-prompt the
	 * same session (bot injected the new CI log) and push to the SAME MR
	 * branch. `priorMrUrl` is the MR the agent must update, not recreate.
	 */
	continue(
		input: AgentRunInput,
		priorMrUrl: string,
		newCiLog: string,
	): Promise<AgentResult>;
	/**
	 * Resume a retained escalation after a human decision (T06). OPTIONAL —
	 * runners without resume support make runResumeRepair fail loud. Re-opens
	 * the retained session, injects the decision as a new user message, and
	 * runs with a FRESH budget (the runner instance is fresh per worker).
	 */
	resume?(input: AgentRunInput, decision: ResumeDecision): Promise<AgentResult>;
	/** Release any open session/resources held across a retry loop. */
	close(): void;
}

/**
 * Stub runner for the tracer bullet.
 *
 * Returns a fixed class-1 (test bug) diagnosis + a canned fix diff touching
 * only a test file. This lets the end-to-end pipe prove out without a real
 * LLM; ticket 02 replaces this with a real pi session.
 *
 * CIHEAL_STUB_FIX_KIND controls the returned fix:
 *   "test"      (default) — a safe test-file fix (class 1 happy path)
 *   "src-main"  — a fix that touches src/main (G3 violation → must escalate)
 */
export class StubAgentRunner implements AgentRunner {
	async run(input: AgentRunInput): Promise<AgentResult> {
		const diagnosis: Diagnosis = {
			failureClass: 1,
			summary: "测试断言写错：CalculatorTest 期望 4 但实际应为 5（2+3）。",
		};
		const kind = process.env.CIHEAL_STUB_FIX_KIND ?? "test";
		// Simulate the agent self-executing: write the canned edit to the working
		// tree so `git diff` in run-repair is authoritative (no diff in the result).
		if (kind === "src-main") {
			writeStubFile(
				joinPath(input.cwd, "src/main/java/com/example/Calculator.java"),
				"// stub production change — must be rejected by G3\n",
			);
			return {
				kind: "fixed",
				diagnosis,
				summary: "（stub）试图改生产代码——应被 G3 拦截。",
			};
		}
		writeStubFile(
			joinPath(input.cwd, "src/test/java/com/example/CalculatorTest.java"),
			"package com.example;\n// fixed assertion: assertEquals(5, ...)\n",
		);
		// The agent creates the MR itself (git push + glab mr create) and returns
		// its URL; the bot only consumes mrUrl (it does not call glab). Mirror the
		// stubSessionFactory contract so the tracer-bullet (which drives this
		// StubAgentRunner via the default CIHEAL_AGENT_MODE) produces an MR outcome.
		return {
			kind: "fixed",
			diagnosis,
			summary: "修正 CalculatorTest 断言为期望值 5。",
			mrUrl: "https://gitlab.example.com/example/project/-/merge_requests/1",
		};
	}

	async continue(
		input: AgentRunInput,
		priorMrUrl: string,
		_newCiLog: string,
	): Promise<AgentResult> {
		const diagnosis: Diagnosis = {
			failureClass: 1,
			summary: "重试：修正断言为期望值 5。",
		};
		const kind = process.env.CIHEAL_STUB_FIX_KIND ?? "test";
		if (kind === "src-main") {
			writeStubFile(
				joinPath(input.cwd, "src/main/java/com/example/Calculator.java"),
				"// stub production change — must be rejected by G3\n",
			);
			return {
				kind: "fixed",
				diagnosis,
				summary: "（stub）重试仍试图改生产代码——应被 G3 拦截。",
			};
		}
		writeStubFile(
			joinPath(input.cwd, "src/test/java/com/example/CalculatorTest.java"),
			"package com.example;\n// retry fix assertion: assertEquals(5, ...)\n",
		);
		return {
			kind: "fixed",
			diagnosis,
			summary: "重试修正 CalculatorTest 断言为 5。",
			mrUrl: priorMrUrl,
		};
	}

	/**
	 * Canned resume (T06): reuses the run() fix behavior — the stub writes its
	 * canned test fix into the retained repo and reports fixed, so e2e stub
	 * mode exercises the full resume pipeline without an LLM.
	 */
	async resume(input: AgentRunInput, _decision: ResumeDecision): Promise<AgentResult> {
		return this.run(input);
	}

	close(): void {
		// Stub holds no open session.
	}
}

function writeStubFile(abs: string, content: string): void {
	mkdirSync(dirname(abs), { recursive: true });
	writeFileSync(abs, content, "utf8");
}

/** Parse the MR iid out of an MR URL (.../merge_requests/<iid>). */
export function parseMrIid(mrUrl: string | undefined): number | null {
	if (!mrUrl) return null;
	const m = mrUrl.match(/merge_requests\/(\d+)/);
	return m ? Number(m[1]) : null;
}
