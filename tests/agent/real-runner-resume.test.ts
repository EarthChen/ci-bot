import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
	RealAgentRunner,
	findSessionFile,
	type SessionFactory,
} from "../../src/agent/real-runner.js";
import { buildDecisionPrompt } from "../../src/agent/ci-repair-definition.js";
import type { AgentSession } from "@earendil-works/pi-coding-agent";

const input = {
	projectId: "group/project",
	pipelineId: 42,
	ref: "main",
	sha: "0123456789abcdef",
	ciLog: "test failure log",
	mrDiff: "",
	cwd: "/tmp/ci-heal-resume-test",
	sourceBranch: "ci-self-heal/main-01234567",
	targetBranch: "main",
};

const FIXED_JSON = JSON.stringify({
	kind: "fixed",
	diagnosis: { failureClass: 1, summary: "断言错误" },
	summary: "修正断言",
	mrUrl: "https://gitlab.example.com/g/p/-/merge_requests/9",
});

/** Fake session recording the prompt it receives (the injected user message). */
function promptCapturingFactory(
	finalText: string,
	totalTokens: number,
): { factory: SessionFactory; prompts: string[] } {
	const prompts: string[] = [];
	const factory: SessionFactory = () => {
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
			async prompt(text: string): Promise<void> {
				prompts.push(text);
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
	return { factory, prompts };
}

describe("findSessionFile（T06 session 发现）", () => {
	let agentDir: string;

	beforeEach(() => {
		agentDir = mkdtempSync(join(tmpdir(), "resume-discovery-"));
	});
	afterEach(() => {
		rmSync(agentDir, { recursive: true, force: true });
	});

	it("返回 sessions/ 下最新的 *.jsonl", () => {
		const dir = join(agentDir, "sessions", "--tmp-repo--");
		mkdirSync(dir, { recursive: true });
		const older = join(dir, "20260816_aaa.jsonl");
		const newer = join(dir, "20260817_bbb.jsonl");
		writeFileSync(older, "{}\n");
		writeFileSync(newer, "{}\n");
		// Force distinct mtimes.
		const { utimesSync } = require("node:fs") as typeof import("node:fs");
		utimesSync(older, new Date("2026-08-16"), new Date("2026-08-16"));
		utimesSync(newer, new Date("2026-08-17"), new Date("2026-08-17"));

		expect(findSessionFile(agentDir)).toBe(newer);
	});

	it("sessions/ 为空时回退到 agentDir 下任意 *.jsonl", () => {
		const stray = join(agentDir, "somewhere", "stray.jsonl");
		mkdirSync(join(agentDir, "somewhere"), { recursive: true });
		writeFileSync(stray, "{}\n");
		expect(findSessionFile(agentDir)).toBe(stray);
	});

	it("无任何 session 文件 → 抛错（fail loud，绝不静默新建会话）", () => {
		expect(() => findSessionFile(agentDir)).toThrow(/session 文件缺失/);
	});

	it("agentDir 不存在 → 抛错", () => {
		expect(() => findSessionFile(join(agentDir, "nope"))).toThrow(
			/session 文件缺失/,
		);
	});
});

describe("RealAgentRunner.resume（T06 runner seam）", () => {
	let agentDir: string;
	let savedAgentDir: string | undefined;

	beforeEach(() => {
		agentDir = mkdtempSync(join(tmpdir(), "resume-runner-"));
		savedAgentDir = process.env.PI_CODING_AGENT_DIR;
		process.env.PI_CODING_AGENT_DIR = agentDir;
	});
	afterEach(() => {
		if (savedAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
		else process.env.PI_CODING_AGENT_DIR = savedAgentDir;
		rmSync(agentDir, { recursive: true, force: true });
	});

	function plantSession(): string {
		const dir = join(agentDir, "sessions", "--tmp-repo--");
		mkdirSync(dir, { recursive: true });
		const file = join(dir, "20260817_retained.jsonl");
		writeFileSync(file, "{}\n");
		return file;
	}

	it("以发现的 session 文件打开会话（SessionManager.open 契约），注入决策 prompt", async () => {
		const sessionFile = plantSession();
		const { factory, prompts } = promptCapturingFactory(FIXED_JSON, 10);
		const spy = vi.fn(factory);
		const runner = new RealAgentRunner({ sessionFactory: spy });

		const result = await runner.resume(input, {
			value: "test",
			remark: "spec 规定应为 5",
		});

		expect(result.kind).toBe("fixed");
		// Factory received the discovered session file → session re-opened, not fresh.
		expect(spy).toHaveBeenCalledWith(input, { sessionFile });
		// Decision prompt injected as the user message.
		expect(prompts).toHaveLength(1);
		expect(prompts[0]).toBe(
			buildDecisionPrompt({ value: "test", remark: "spec 规定应为 5" }),
		);
		runner.close();
	});

	it("session 文件缺失 → escalated「session 文件缺失」，绝不新建会话", async () => {
		const spy = vi.fn(promptCapturingFactory(FIXED_JSON, 10).factory);
		const runner = new RealAgentRunner({ sessionFactory: spy });

		const result = await runner.resume(input, { value: "test", remark: "" });

		expect(result).toMatchObject({ kind: "escalated", source: "runtime" });
		expect(result.kind === "escalated" && result.reason).toContain(
			"session 文件缺失",
		);
		expect(spy).not.toHaveBeenCalled(); // no fresh session
		runner.close();
	});

	it("resume 预算独立计量（fresh budget，超限即 escalate）", async () => {
		plantSession();
		const { factory } = promptCapturingFactory("irrelevant", 500);
		const runner = new RealAgentRunner({
			sessionFactory: factory,
			budget: { perTurnTokenLimit: 100, totalTokenLimit: 100_000 },
		});

		const result = await runner.resume(input, { value: "test", remark: "" });

		expect(result).toMatchObject({ kind: "escalated", source: "runtime" });
		expect(result.kind === "escalated" && result.reason).toContain("budget");
		runner.close();
	});
});
