import { describe, expect, it } from "vitest";
import { FAILURE_CLASS_NAMES, formatFailureClass } from "../src/types.js";

describe("FAILURE_CLASS_NAMES — G1 权威类名", () => {
	it("五类齐全，文案与 playbook diagnosis-detail.md 标题逐字一致", () => {
		expect(FAILURE_CLASS_NAMES[1]).toBe("测试 bug（断言/mock/数据错）");
		expect(FAILURE_CLASS_NAMES[2]).toBe("被测代码变更导致测试过时");
		expect(FAILURE_CLASS_NAMES[3]).toBe("缺失测试");
		expect(FAILURE_CLASS_NAMES[4]).toBe("flaky / 环境问题");
		expect(FAILURE_CLASS_NAMES[5]).toBe("非单测失败（编译/依赖）");
	});

	it("formatFailureClass：已知类 → class N（类名）；未知数字退化为 class N", () => {
		expect(formatFailureClass(3)).toBe("class 3（缺失测试）");
		expect(formatFailureClass(9)).toBe("class 9");
	});
});
