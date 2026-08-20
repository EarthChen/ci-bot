import { describe, expect, it } from "vitest";
import {
	RealAgentRunner,
	summarizeUnparseable,
	UNPARSEABLE_SUMMARY_CHARS,
} from "../../src/agent/real-runner.js";
import { tryParseAgentJson } from "../../src/agents/ci-repair/result-parser.js";

const input = {
	projectId: "group/project",
	pipelineId: 42,
	ref: "main",
	sha: "0123456789abcdef",
	ciLog: "no model available",
	mrDiff: "",
	cwd: "/tmp/ci-heal-test",
	sourceBranch: "main",
	targetBranch: "master",
};

describe("RealAgentRunner", () => {
	it("rejects invalid G1 failure classes from agent output", () => {
		expect(
			tryParseAgentJson(
				'{"kind":"fixed","diagnosis":{"failureClass":6,"summary":"bad"},"summary":"bad"}',
			),
		).toBeNull();
	});

	it("escalates when no provider/model can initialize a session", async () => {
		const runner = new RealAgentRunner({
			sessionFactory: async () => {
				throw new Error("no available model candidate");
			},
		});

		await expect(runner.run(input)).resolves.toMatchObject({
			kind: "escalated",
			diagnosis: {
				failureClass: 4,
			},
		});
	});
});

describe("summarizeUnparseable — unparseable 摘要完整性", () => {
	it("短文本原样保留", () => {
		expect(summarizeUnparseable("abc")).toBe("abc");
	});

	it("超长截断到上限并带省略号（旧 200 字符曾截断 MR !281 根因描述）", () => {
		const out = summarizeUnparseable("x".repeat(2000));
		expect(out).toHaveLength(UNPARSEABLE_SUMMARY_CHARS + 1);
		expect(out.endsWith("…")).toBe(true);
	});

	it("上限足够承载完整诊断上下文（≥1000）", () => {
		expect(UNPARSEABLE_SUMMARY_CHARS).toBeGreaterThanOrEqual(1000);
	});
});
