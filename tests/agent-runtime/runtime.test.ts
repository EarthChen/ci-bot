import { describe, expect, it } from "vitest";
import type { AgentSession } from "@earendil-works/pi-coding-agent";
import {
	SharedAgentRuntime,
	type AgentDefinition,
	type RuntimeSessionBundle,
} from "../../src/agent-runtime/runtime.js";

interface FakeMessage {
	readonly role: "assistant";
	readonly content: readonly [{ readonly type: "text"; readonly text: string }];
	readonly usage: { readonly totalTokens: number };
}

function createSession(
	text: string,
	totalTokens = 100,
): {
	readonly session: AgentSession;
	readonly prompted: () => string | undefined;
	readonly aborted: () => boolean;
} {
	const messages: FakeMessage[] = [];
	const listeners: Array<
		(event: { type: "turn_end"; message: FakeMessage }) => void
	> = [];
	let prompt: string | undefined;
	let aborted = false;

	return {
		session: {
			subscribe(
				listener: (event: { type: "turn_end"; message: FakeMessage }) => void,
			) {
				listeners.push(listener);
				return () => {
					const index = listeners.indexOf(listener);
					if (index >= 0) listeners.splice(index, 1);
				};
			},
			async prompt(value: string) {
				prompt = value;
				const message: FakeMessage = {
					role: "assistant",
					content: [{ type: "text", text }],
					usage: { totalTokens },
				};
				messages.push(message);
				for (const listener of listeners)
					listener({ type: "turn_end", message });
			},
			async abort() {
				aborted = true;
			},
			get messages() {
				return messages;
			},
		} as unknown as AgentSession,
		prompted: () => prompt,
		aborted: () => aborted,
	};
}

const definition: AgentDefinition<{ readonly task: string }> = {
	id: "test-coding-agent",
	modelPolicy: "default",
	capabilityProfile: "workspace-coding",
	resources: {
		appendSystemPromptPath: ".pi/APPEND_SYSTEM.md",
		skillPaths: [".agents/skills/test-coding"],
	},
	buildPrompt(input) {
		return `Complete: ${input.task}`;
	},
};

describe("SharedAgentRuntime", () => {
	it("runs a static vertical agent without interpreting its business input", async () => {
		const fake = createSession("completed");
		let captured: RuntimeSessionBundle | undefined;
		const runtime = new SharedAgentRuntime({
			sessionFactory: async (request) => {
				expect(request.definition).toBe(definition);
				expect(request.cwd).toBe("/tmp/agent-workspace");
				captured = { session: fake.session, dispose() {} };
				return captured;
			},
		});

		const result = await runtime.run({
			definition,
			input: { task: "format the README" },
			cwd: "/tmp/agent-workspace",
		});

		expect(fake.prompted()).toBe("Complete: format the README");
		expect(result).toEqual({
			status: "completed",
			finalText: "completed",
			metrics: { turns: 1, tokens: 100 },
		});
		expect(captured).toBeDefined();
	});

	it("returns a budget result when a vertical agent exceeds the shared limit", async () => {
		const fake = createSession("too expensive", 101);
		const runtime = new SharedAgentRuntime({
			budget: { perTurnTokenLimit: 100 },
			sessionFactory: async () => ({ session: fake.session, dispose() {} }),
		});

		const result = await runtime.run({
			definition,
			input: { task: "format the README" },
			cwd: "/tmp/agent-workspace",
		});

		expect(fake.aborted()).toBe(true);
		expect(result).toMatchObject({
			status: "budget_exceeded",
			metrics: { turns: 1, tokens: 101 },
		});
	});

	it("returns a safe failure when session setup fails", async () => {
		const runtime = new SharedAgentRuntime({
			sessionFactory: async () => {
				throw new Error("provider response contains secret");
			},
		});

		await expect(
			runtime.run({
				definition,
				input: { task: "format the README" },
				cwd: "/tmp/agent-workspace",
			}),
		).resolves.toEqual({
			status: "failed",
			failure: "session_setup_failed",
			metrics: { turns: 0, tokens: 0 },
		});
	});
});
