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
 *   "test"          (default) — class-1 fix touching only a test file (happy path)
 *   "src-main"      — a fix touching src/main (exercises G3 boundary enforcement)
 *   "escalate"      — an escalated result (class 4 flaky, exercises escalation DingTalk path)
 *   "class2"        — class-2 fix: test file + docs file (behavior change → doc sync)
 *   "class3-spec"   — class-3 fix: new conformance test file (spec readable)
 *   "class3-no-spec" — escalated (spec unreadable/missing)
 *   "class3-mismatch" — escalated (code behavior ≠ spec)
 *   "class4"        — escalated (flaky, alias of escalate)
 *
 * CIHEAL_STUB_TURN_TOKENS controls the per-turn usage reported in turn_end,
 * for testing the budget soft limit (set high to trip the per-turn abort).
 */

import type { AgentResult, Diagnosis } from "../types.js";
import type { AgentRunInput } from "./runner.js";
import type { SessionFactory } from "./real-runner.js";
import type { RuntimeSessionBundle } from "../agent-runtime/runtime.js";
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
	// Escalation variants (class 3 boundaries + class 4 flaky).
	if (kind === "escalate" || kind === "class4") {
		return {
			kind: "escalated",
			diagnosis: { failureClass: 4, summary: "（stub）flaky，转交人工" },
			reason: "stub escalation: flaky test",
		};
	}
	if (kind === "class3-no-spec") {
		return {
			kind: "escalated",
			diagnosis: {
				failureClass: 3,
				summary: "（stub）spec 不可读/缺失，转交人工",
			},
			reason: "stub escalation: spec unreadable",
		};
	}
	if (kind === "class3-mismatch") {
		return {
			kind: "escalated",
			diagnosis: {
				failureClass: 3,
				summary: "（stub）代码行为 ≠ spec，转交人工",
			},
			reason: "stub escalation: code ≠ spec",
		};
	}
	// Fixed variants (class 1/2/3).
	const classMap: Record<string, 1 | 2 | 3> = {
		test: 1,
		"src-main": 1,
		class2: 2,
		"class3-spec": 3,
	};
	const failureClass = classMap[kind] ?? 1;
	const summaryMap: Record<string, string> = {
		test: "测试断言写错：CalculatorTest 期望 4 但实际应为 5（2+3）。",
		"src-main": "（stub）试图改生产代码——应被 G3 拦截。",
		class2: "被测代码 add() 返回值变更，测试断言过时；同步文档。",
		"class3-spec": "按 spec 补符合性测试：Calculator.add(2,3) 应返回 5。",
	};
	const diagnosis: Diagnosis = {
		failureClass,
		summary: summaryMap[kind] ?? summaryMap.test,
	};
	// The current architecture has the agent create the MR itself (git push +
	// glab mr create) and return its URL; the bot only consumes mrUrl. The
	// stub mirrors that contract. `src-main` intentionally omits mrUrl so the
	// run-repair escalates (G3 boundary: a src/main edit must not produce an
	// MR) — G3 validation is skipped, so the missing mrUrl is the escalation
	// trigger, exactly as the G3 e2e asserts.
	const mrUrl =
		kind === "src-main"
			? undefined
			: "https://gitlab.example.com/example/project/-/merge_requests/1";
	return {
		kind: "fixed",
		diagnosis,
		summary: summaryMap[kind] ?? "修正 CalculatorTest 断言为期望值 5。",
		mrUrl,
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
	if (kind === "class2") {
		// class 2: update stale test assertion + sync relevant doc paragraph.
		writeFile(
			joinPath(cwd, "src/test/java/com/example/CalculatorTest.java"),
			"package com.example;\n// updated: assertEquals(5, calc.add(2,3))\n",
		);
		writeFile(
			joinPath(cwd, "docs/api.md"),
			"# Calculator API\n\n`add(a, b)` returns the sum. `add(2,3)` returns 5.\n",
		);
		return;
	}
	if (kind === "class3-spec") {
		// class 3: add a new conformance test asserting spec-defined behavior.
		writeFile(
			joinPath(cwd, "src/test/java/com/example/CalculatorConformanceTest.java"),
			"package com.example;\n// spec conformance: add(2,3)==5 per spec\n",
		);
		return;
	}
	// Default (class 1): fix the test assertion.
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
	const bundle: RuntimeSessionBundle = {
		session: session as unknown as AgentSession,
		dispose: () => session.dispose(),
	};
	return Promise.resolve(bundle);
};
