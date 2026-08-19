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

describe("buildDecisionPrompt — widen（ADR-0009）", () => {
	it("widen：含批准扩围清单与范围边界；不复用 test 决策文案", () => {
		const prompt = buildDecisionPrompt({
			value: "widen",
			remark: "",
			oosPaths: ["m/src/test/java/TTest.java"],
		});
		expect(prompt).toContain("/heal widen");
		expect(prompt).toContain("- m/src/test/java/TTest.java");
		expect(prompt).toContain("diff 外的 src/main 一律禁碰");
		expect(prompt).not.toContain("该失败按测试侧问题处理");
	});

	it("test 决策不渲染扩围清单段", () => {
		const prompt = buildDecisionPrompt({ value: "test", remark: "" });
		expect(prompt).not.toContain("批准扩围的文件");
	});
});
