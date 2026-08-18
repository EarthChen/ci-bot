import { describe, expect, it } from "vitest";
import { RealAgentRunner } from "../../src/agent/real-runner.js";
import type { SessionFactory } from "../../src/agent/real-runner.js";
import { tryParseAgentJson } from "../../src/agents/ci-repair/result-parser.js";
import { isDecidableEscalation } from "../../src/pipeline/run-repair.js";
import type { AgentResult } from "../../src/types.js";
import type { AgentSession } from "@earendil-works/pi-coding-agent";

const input = {
	projectId: "group/project",
	pipelineId: 42,
	ref: "main",
	sha: "0123456789abcdef",
	ciLog: "test failure log",
	mrDiff: "",
	cwd: "/tmp/ci-heal-test",
	sourceBranch: "ci-self-heal/main-01234567",
	targetBranch: "main",
};

/** Minimal fake session: emits one turn_end with the given usage + final text. */
function fakeSessionFactory(
	finalText: string,
	totalTokens: number,
): SessionFactory {
	return () => {
		const listeners: Array<(event: unknown) => void> = [];
		const message = {
			role: "assistant",
			content: [{ type: "text", text: finalText }],
			usage: { totalTokens },
		};
		const session = {
			subscribe(listener: (event: unknown) => void): () => void {
				listeners.push(listener);
				return () => {};
			},
			async prompt(): Promise<void> {
				for (const listener of listeners) {
					listener({ type: "turn_end", message });
				}
			},
			async abort(): Promise<void> {},
			dispose(): void {},
			messages: [message],
		};
		return Promise.resolve({
			session: session as unknown as AgentSession,
			dispose: () => session.dispose(),
		});
	};
}

describe("AgentResult source tagging", () => {
	it("agent-sourced escalated JSON parses to source: 'agent'", () => {
		const result = tryParseAgentJson(
			'{"kind":"escalated","diagnosis":{"failureClass":3,"summary":"spec unreadable"},"reason":"need human decision"}',
		);
		expect(result).not.toBeNull();
		expect(result).toMatchObject({ kind: "escalated", source: "agent" });
	});

	it("budget-exceeded escalation is source: 'runtime'", async () => {
		const runner = new RealAgentRunner({
			sessionFactory: fakeSessionFactory("irrelevant", 500),
			budget: { perTurnTokenLimit: 100, totalTokenLimit: 100_000 },
		});
		const result = await runner.run(input);
		expect(result).toMatchObject({ kind: "escalated", source: "runtime" });
		expect(result.kind === "escalated" && result.reason).toContain("budget");
		runner.close();
	});

	it("unparseable agent output escalates as source: 'runtime'", async () => {
		const runner = new RealAgentRunner({
			sessionFactory: fakeSessionFactory("this is not structured json", 10),
		});
		const result = await runner.run(input);
		expect(result).toMatchObject({ kind: "escalated", source: "runtime" });
		runner.close();
	});
});

describe("isDecidableEscalation", () => {
	const diagnosis = { failureClass: 3 as const, summary: "spec unreadable" };

	it("true for agent-sourced escalated with diagnosis", () => {
		const result: AgentResult = {
			kind: "escalated",
			diagnosis,
			reason: "need human",
			source: "agent",
		};
		expect(isDecidableEscalation(result)).toBe(true);
	});

	it("false for runtime-sourced escalated (budget/error/parse)", () => {
		const result: AgentResult = {
			kind: "escalated",
			diagnosis,
			reason: "budget exceeded",
			source: "runtime",
		};
		expect(isDecidableEscalation(result)).toBe(false);
	});

	it("false for fixed results", () => {
		const result: AgentResult = {
			kind: "fixed",
			diagnosis,
			summary: "fixed the test",
		};
		expect(isDecidableEscalation(result)).toBe(false);
	});

	it("false for agent-sourced escalated missing diagnosis (defensive)", () => {
		const result = {
			kind: "escalated",
			reason: "malformed",
			source: "agent",
		} as unknown as AgentResult;
		expect(isDecidableEscalation(result)).toBe(false);
	});

	it("false for class-5 diagnosis（无决策价值，不冻干现场）", () => {
		const result: AgentResult = {
			kind: "escalated",
			diagnosis: { failureClass: 5 as const, summary: "src/main compile error" },
			reason: "class 5 handoff",
			source: "agent",
		};
		expect(isDecidableEscalation(result)).toBe(false);
	});
});
