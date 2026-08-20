import { afterEach, describe, expect, it, vi } from "vitest";
import type { AgentSession } from "@earendil-works/pi-coding-agent";
import {
	SharedAgentRuntime,
	type AgentDefinition,
	type RuntimeSessionBundle,
} from "../../src/agent-runtime/runtime.js";

interface FakeMessage {
	readonly role: "assistant";
	readonly content: readonly [{ readonly type: "text"; readonly text: string }];
	readonly usage: Record<string, number>;
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
	schedulingPolicy: {
		serialKey: (event: { readonly projectId: string }) => event.projectId,
		maxParallel: 1,
	},
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
			metrics: { turns: 1, tokens: 100, usage: { input: 100, output: 0, cacheRead: 0, cacheWrite: 0, reasoning: 0 } },
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

describe("SharedAgentRuntime IPC progress", () => {
	// vitest forks 池里 process.send 指向 tinypool 通道——覆写后必须还原，
	// 否则破坏 vitest 自身 IPC（同 tests/dashboard/ipc.test.ts 的处理）。
	const savedFlag = process.env.CIHEAL_WORKER_IPC;
	const savedSend = process.send;

	afterEach(() => {
		if (savedFlag === undefined) delete process.env.CIHEAL_WORKER_IPC;
		else process.env.CIHEAL_WORKER_IPC = savedFlag;
		(process as { send?: unknown }).send = savedSend;
	});

	/** prompt() 时按序发出 turn_start → tool_execution_start → turn_end 的假 session。 */
	function createEventSession(
		totalTokens: number,
		components?: {
			readonly input: number;
			readonly output: number;
			readonly cacheRead: number;
			readonly cacheWrite: number;
			readonly reasoning: number;
		},
	): { readonly session: AgentSession } {
		const listeners: Array<(event: unknown) => void> = [];
		const message: FakeMessage = {
			role: "assistant",
			content: [{ type: "text", text: "done" }],
			usage: components ? { ...components, totalTokens } : { totalTokens },
		};
		return {
			session: {
				subscribe(listener: (event: unknown) => void) {
					listeners.push(listener);
					return () => {
						const index = listeners.indexOf(listener);
						if (index >= 0) listeners.splice(index, 1);
					};
				},
				async prompt() {
					for (const listener of listeners) {
						listener({ type: "turn_start" });
						listener({
							type: "tool_execution_start",
							toolCallId: "t1",
							toolName: "read",
							args: { path: "ci-log.txt" },
						});
						listener({ type: "turn_end", message, toolResults: [] });
					}
				},
				async abort() {},
				get messages() {
					return [message];
				},
			} as unknown as AgentSession,
		};
	}

	it("turn/tool session 事件转发为 IPC 消息（tokens 为累计值）", async () => {
		const send = vi.fn();
		(process as { send?: unknown }).send = send;
		process.env.CIHEAL_WORKER_IPC = "1";

		const runtime = new SharedAgentRuntime({
			sessionFactory: async () => ({
				session: createEventSession(100).session,
				dispose() {},
			}),
		});
		await runtime.run({ definition, input: { task: "x" }, cwd: "/tmp/x" });

		expect(send).toHaveBeenCalledWith({ type: "turn_start", turn: 1 });
		expect(send).toHaveBeenCalledWith({
			type: "tool_call",
			name: "read",
			summary: "ci-log.txt",
		});
		expect(send).toHaveBeenCalledWith({
			type: "turn_end",
			turn: 1,
			tokens: 100,
			cost: 0.0001,
		});
	});

	it("turn_end cost 按 usage 分量计价（cache 重读低价，不再按总量平价）", async () => {
		const send = vi.fn();
		(process as { send?: unknown }).send = send;
		process.env.CIHEAL_WORKER_IPC = "1";

		const runtime = new SharedAgentRuntime({
			sessionFactory: async () => ({
				session: createEventSession(1160, {
					input: 100,
					output: 50,
					cacheRead: 1000,
					cacheWrite: 0,
					reasoning: 10,
				}).session,
				dispose() {},
			}),
		});
		await runtime.run({ definition, input: { task: "x" }, cwd: "/tmp/x" });

		// 100 input + (50+10)×4 output/reasoning + 1000×0.1 cacheRead = 440
		// → 440/1000 × 0.001 = 0.00044（旧平价公式会算出 0.00116，虚高 2.6 倍）
		expect(send).toHaveBeenCalledWith({
			type: "turn_end",
			turn: 1,
			tokens: 1160,
			cost: 0.00044,
		});
	});

	it("未接 IPC 通道（无 CIHEAL_WORKER_IPC）时不发送", async () => {
		const send = vi.fn();
		(process as { send?: unknown }).send = send;
		delete process.env.CIHEAL_WORKER_IPC;

		const runtime = new SharedAgentRuntime({
			sessionFactory: async () => ({
				session: createEventSession(100).session,
				dispose() {},
			}),
		});
		await runtime.run({ definition, input: { task: "x" }, cwd: "/tmp/x" });

		expect(send).not.toHaveBeenCalled();
	});
});
