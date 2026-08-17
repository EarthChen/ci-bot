import { describe, expect, it } from "vitest";
import { buildDecisionPrompt } from "../../src/agent/ci-repair-definition.js";

describe("buildDecisionPrompt（T06）", () => {
	it("宣告决策为最终决定，按测试侧问题处理", () => {
		const prompt = buildDecisionPrompt({ value: "test", remark: "" });
		expect(prompt).toContain("最终");
		expect(prompt).toContain("测试");
	});

	it("remark 存在时作为权威 spec 上下文注入", () => {
		const prompt = buildDecisionPrompt({
			value: "test",
			remark: "spec 规定 add(2,3) 应返回 5",
		});
		expect(prompt).toContain("spec 规定 add(2,3) 应返回 5");
	});

	it("无 remark 时不伪造上下文", () => {
		const prompt = buildDecisionPrompt({ value: "test", remark: "" });
		expect(prompt).not.toContain("spec 规定");
	});

	it("守住 G3 边界（只改测试/文档，禁碰生产代码）", () => {
		const prompt = buildDecisionPrompt({ value: "test", remark: "" });
		expect(prompt).toContain("src/main");
	});

	it("以结构化 JSON 结果契约收尾（fixed/escalated）", () => {
		const prompt = buildDecisionPrompt({ value: "test", remark: "" });
		expect(prompt).toContain("fixed");
		expect(prompt).toContain("escalated");
		expect(prompt).toContain("JSON");
	});
});
