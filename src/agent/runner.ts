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

import type { AgentResult, Diagnosis, FixDiff } from "../types.js";

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
 */
export class StubAgentRunner implements AgentRunner {
  async run(): Promise<AgentResult> {
    const diagnosis: Diagnosis = {
      failureClass: 1,
      summary: "测试断言写错：CalculatorTest 期望 4 但实际应为 5（2+3）。",
    };
    const fix: FixDiff = {
      summary: "修正 CalculatorTest 断言为期望值 5。",
      files: [
        {
          path: "src/test/java/com/example/CalculatorTest.java",
          content: [
            "package com.example;",
            "",
            "import org.junit.jupiter.api.Test;",
            "import static org.junit.jupiter.api.Assertions.assertEquals;",
            "",
            "class CalculatorTest {",
            "    @Test",
            "    void addsTwoPlusThree() {",
            "        assertEquals(5, new Calculator().add(2, 3));",
            "    }",
            "}",
            "",
          ].join("\n"),
        },
      ],
    };
    return { kind: "fixed", diagnosis, fix };
  }
}
