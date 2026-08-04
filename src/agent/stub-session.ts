/**
 * Stub pi session — a fake `AgentSession` for e2e fixture tests.
 *
 * Spec (ticket 02): "测试用 fixture 代替 agent（pi createAgentSession stub
 * 返回 canned 诊断 + fix diff）". This stub lets the e2e test drive the REAL
 * `RealAgentRunner` path (budget accumulation, structured-result parsing,
 * G3 validation, MR creation, DingTalk notification) without a live LLM.
 *
 * It implements the subset of the `AgentSession` surface the runner uses:
 * `subscribe`, `prompt`, `abort`, `dispose`, `messages`.
 *
 * CIHEAL_STUB_FIX_KIND controls the canned result:
 *   "test"     (default) — class-1 fix touching only a test file (happy path)
 *   "src-main" — a fix touching src/main (exercises G3 boundary enforcement)
 *   "escalate" — an escalated result (exercises escalation DingTalk path)
 *
 * CIHEAL_STUB_TURN_TOKENS controls the per-turn usage reported in turn_end,
 * for testing the budget soft limit (set high to trip the per-turn abort).
 */

import type { AgentResult, Diagnosis } from "../types.js";
import type { AgentRunInput } from "./runner.js";
import type { SessionBundle, SessionFactory } from "./real-runner.js";
import type { AgentSession } from "@earendil-works/pi-coding-agent";
import { writeFileSync, mkdirSync } from "node:fs";
import { dirname, join as joinPath } from "node:path";

/** A minimal assistant message shape the runner's parseResult + budget read. */
interface FakeAssistantMessage {
	role: "assistant";
	content: Array<{ type: string; text?: string }>;
	usage: { totalTokens: number };
}

/** A minimal event the runner's subscriber inspects. */
interface FakeTurnEndEvent {
	type: "turn_end";
	message: FakeAssistantMessage;
}

/** A fake session satisfying the AgentSession subset RealAgentRunner uses. */
class StubSession {
	private _messages: FakeAssistantMessage[] = [];
	private listeners: Array<(event: FakeTurnEndEvent) => void> = [];
	private readonly cannedResult: AgentResult;
	private readonly turnTokens: number;
	private readonly cwd: string;

	constructor(cannedResult: AgentResult, turnTokens: number, cwd: string) {
		this.cannedResult = cannedResult;
		this.turnTokens = turnTokens;
		this.cwd = cwd;
	}

	subscribe(listener: (event: FakeTurnEndEvent) => void): () => void {
		this.listeners.push(listener);
		return () => {
			this.listeners = this.listeners.filter((l) => l !== listener);
		};
	}

	async prompt(_text: string): Promise<void> {
		// Simulate the agent self-executing: write canned edits to the working
		// tree so `git diff` in run-repair sees real changes (no diff in prompt).
		applyStubEdits(this.cwd, this.cannedResult);
		// Emit a turn_end with the structured result JSON as the final assistant
		// message + a configurable usage for budget tests.
		const message: FakeAssistantMessage = {
			role: "assistant",
			content: [{ type: "text", text: JSON.stringify(this.cannedResult) }],
			usage: { totalTokens: this.turnTokens },
		};
		this._messages.push(message);
		for (const l of this.listeners) {
			l({ type: "turn_end", message });
		}
	}

	async abort(): Promise<void> {
		// No-op: the stub's prompt is synchronous-ish; abort is exercised by
		// the budget logic reading turn_tokens, not by mid-stream cancellation.
	}

	dispose(): void {
		this.listeners = [];
	}

	get messages(): FakeAssistantMessage[] {
		return this._messages;
	}
}

/** Build the canned AgentResult from env switches. */
function cannedResultFromEnv(): AgentResult {
	const kind = process.env.CIHEAL_STUB_FIX_KIND ?? "test";
	if (kind === "escalate") {
		return {
			kind: "escalated",
			diagnosis: { failureClass: 4, summary: "（stub）flaky，转交人工" },
			reason: "stub escalation: flaky test",
		};
	}
	const diagnosis: Diagnosis = {
		failureClass: 1,
		summary: "测试断言写错：CalculatorTest 期望 4 但实际应为 5（2+3）。",
	};
	return {
		kind: "fixed",
		diagnosis,
		summary:
			kind === "src-main"
				? "（stub）试图改生产代码——应被 G3 拦截。"
				: "修正 CalculatorTest 断言为期望值 5。",
	};
}

/**
 * Simulate the agent's bash edits by writing canned files to the working tree.
 * This makes `git diff` in run-repair authoritative — no diff content lives in
 * the prompt or the structured result. CIHEAL_STUB_FIX_KIND selects the path.
 */
function applyStubEdits(cwd: string, result: AgentResult): void {
	if (result.kind !== "fixed") return;
	const kind = process.env.CIHEAL_STUB_FIX_KIND ?? "test";
	if (kind === "src-main") {
		writeFile(
			joinPath(cwd, "src/main/java/com/example/Calculator.java"),
			"// stub production change — must be rejected by G3\n",
		);
		return;
	}
	writeFile(
		joinPath(cwd, "src/test/java/com/example/CalculatorTest.java"),
		"package com.example;\n// fixed assertion: assertEquals(5, ...)\n",
	);
}

function writeFile(abs: string, content: string): void {
	mkdirSync(dirname(abs), { recursive: true });
	writeFileSync(abs, content, "utf8");
}

/**
 * Session factory for e2e tests: returns a StubSession yielding a canned result.
 *
 * This is the seam that lets the e2e test exercise the full RealAgentRunner
 * pipeline (budget, parse, G3, MR, DingTalk) without a live LLM, per spec.
 */
export const stubSessionFactory: SessionFactory = (input: AgentRunInput) => {
	const result = cannedResultFromEnv();
	const turnTokens =
		Number(process.env.CIHEAL_STUB_TURN_TOKENS ?? "1000") || 1000;
	const session = new StubSession(result, turnTokens, input.cwd);
	const bundle: SessionBundle = {
		session: session as unknown as AgentSession,
		dispose: () => session.dispose(),
	};
	return Promise.resolve(bundle);
};
