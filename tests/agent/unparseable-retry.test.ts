import { describe, expect, it } from "vitest";
import { RealAgentRunner } from "../../src/agent/real-runner.js";
import type { SessionFactory } from "../../src/agent/real-runner.js";
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

const VALID_FIXED_JSON =
	'{"kind":"fixed","diagnosis":{"failureClass":1,"summary":"test bug"},"summary":"fixed it","mrUrl":"https://gitlab.example.com/p/-/merge_requests/1"}';

const VALID_ESCALATED_JSON =
	'{"kind":"escalated","diagnosis":{"failureClass":3,"summary":"spec unreadable"},"reason":"need human decision"}';

/**
 * Fake session that returns different text for each prompt() call.
 * `responses[i]` is emitted on the (i+1)-th prompt(); if calls exceed
 * the array length, the last entry is reused.
 */
function fakeMultiPromptSessionFactory(
	responses: ReadonlyArray<{ text: string; totalTokens: number }>,
): SessionFactory {
	return () => {
		let callIndex = 0;
		const listeners: Array<(event: unknown) => void> = [];
		const messages: unknown[] = [];
		const session = {
			subscribe(listener: (event: unknown) => void): () => void {
				listeners.push(listener);
				return () => {};
			},
			async prompt(): Promise<void> {
				const idx = Math.min(callIndex, responses.length - 1);
				const resp = responses[idx];
				callIndex++;
				const message = {
					role: "assistant",
					content: [{ type: "text", text: resp.text }],
					usage: { totalTokens: resp.totalTokens },
				};
				messages.push(message);
				for (const listener of listeners) {
					listener({ type: "turn_end", message });
				}
			},
			async abort(): Promise<void> {},
			dispose(): void {},
			get messages() {
				return messages;
			},
			get promptCallCount() {
				return callIndex;
			},
		};
		return Promise.resolve({
			session: session as unknown as AgentSession,
			dispose: () => session.dispose(),
		});
	};
}

describe("unparseable result auto-retry", () => {
	it("retries once with a JSON-only re-prompt and returns the parsed result", async () => {
		const factory = fakeMultiPromptSessionFactory([
			{ text: "Here is my analysis of the failure...", totalTokens: 100 },
			{ text: VALID_FIXED_JSON, totalTokens: 10 },
		]);
		const runner = new RealAgentRunner({ sessionFactory: factory });
		const result = await runner.run(input);

		expect(result.kind).toBe("fixed");
		expect(result.diagnosis.failureClass).toBe(1);
		runner.close();
	});

	it("returns runtime escalated when retry also fails to parse", async () => {
		const factory = fakeMultiPromptSessionFactory([
			{ text: "free-form analysis, no JSON", totalTokens: 100 },
			{ text: "still not JSON on retry", totalTokens: 10 },
		]);
		const runner = new RealAgentRunner({ sessionFactory: factory });
		const result = await runner.run(input);

		expect(result.kind).toBe("escalated");
		if (result.kind === "escalated") {
			expect(result.source).toBe("runtime");
			expect(result.reason).toContain("unparseable");
		}
		runner.close();
	});

	it("does not retry when the initial result is valid JSON", async () => {
		let promptCount = 0;
		const factory: SessionFactory = () => {
			const listeners: Array<(event: unknown) => void> = [];
			const message = {
				role: "assistant",
				content: [{ type: "text", text: VALID_FIXED_JSON }],
				usage: { totalTokens: 50 },
			};
			const session = {
				subscribe(listener: (event: unknown) => void): () => void {
					listeners.push(listener);
					return () => {};
				},
				async prompt(): Promise<void> {
					promptCount++;
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
		const runner = new RealAgentRunner({ sessionFactory: factory });
		const result = await runner.run(input);

		expect(result.kind).toBe("fixed");
		expect(promptCount).toBe(1);
		runner.close();
	});

	it("retries escalated JSON (agent-sourced) as valid — no retry needed", async () => {
		const factory = fakeMultiPromptSessionFactory([
			{ text: VALID_ESCALATED_JSON, totalTokens: 50 },
		]);
		const runner = new RealAgentRunner({ sessionFactory: factory });
		const result = await runner.run(input);

		expect(result.kind).toBe("escalated");
		if (result.kind === "escalated") {
			expect(result.source).toBe("agent");
		}
		runner.close();
	});
});
