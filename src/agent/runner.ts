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
}

export interface AgentRunner {
  /** Run one agent session. Returns the structured outcome. */
  run(input: AgentRunInput): Promise<AgentResult>;
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
      writeStubFile(joinPath(input.cwd, "src/main/java/com/example/Calculator.java"),
        "// stub production change — must be rejected by G3\n");
      return { kind: "fixed", diagnosis, summary: "（stub）试图改生产代码——应被 G3 拦截。" };
    }
    writeStubFile(joinPath(input.cwd, "src/test/java/com/example/CalculatorTest.java"),
      "package com.example;\n// fixed assertion: assertEquals(5, ...)\n");
    return { kind: "fixed", diagnosis, summary: "修正 CalculatorTest 断言为期望值 5。" };
  }
}

function writeStubFile(abs: string, content: string): void {
  mkdirSync(dirname(abs), { recursive: true });
  writeFileSync(abs, content, "utf8");
}
