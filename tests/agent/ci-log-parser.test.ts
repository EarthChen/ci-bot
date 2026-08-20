import { describe, expect, it } from "vitest";
import {
	parseCheckstyleViolations,
	parseSpotbugsViolations,
} from "../../src/agent/ci-log-parser.js";

const CHECKSTYLE_SAMPLE = `
❌ 以下违规位于本次修改的行上（阻断）:
  [ERROR] /builds/ultron/ultron-room/ultron-room-service/src/main/java/com/foo/Foo.java:46:52: Variable 'propCache' must be private and have accessor methods. [VisibilityModifier]
  [ERROR] /builds/ultron/ultron-room/ultron-room-api/src/main/java/com/bar/Bar.java:113:107: '+' should be on a new line. [OperatorWrap]
`;

describe("parseCheckstyleViolations", () => {
	it("解析标准 checkstyle 输出", () => {
		const violations = parseCheckstyleViolations(CHECKSTYLE_SAMPLE);
		expect(violations).toHaveLength(2);
		expect(violations[0]).toEqual({
			file: "ultron/ultron-room/ultron-room-service/src/main/java/com/foo/Foo.java",
			line: 46,
			rule: "VisibilityModifier",
			message:
				"Variable 'propCache' must be private and have accessor methods.",
		});
		expect(violations[1]).toEqual({
			file: "ultron/ultron-room/ultron-room-api/src/main/java/com/bar/Bar.java",
			line: 113,
			rule: "OperatorWrap",
			message: "'+' should be on a new line.",
		});
	});

	it("路径标准化：去掉 /builds/ 前缀", () => {
		const log =
			"[ERROR] /builds/g/p/svc/src/main/Foo.java:1:1: msg [Rule]";
		const [v] = parseCheckstyleViolations(log);
		expect(v.file).toBe("g/p/svc/src/main/Foo.java");
	});

	it("空输入返回空数组", () => {
		expect(parseCheckstyleViolations("")).toEqual([]);
		expect(parseCheckstyleViolations("no checkstyle here")).toEqual([]);
	});
});

describe("parseSpotbugsViolations", () => {
	it("暂未实现 → 返回空数组", () => {
		const log = `
[INFO] BugInstance size is 2
[ERROR] High: ... [NP_NULL_ON_SOME_PATH]
`;
		expect(parseSpotbugsViolations(log)).toEqual([]);
	});

	it("空输入返回空数组", () => {
		expect(parseSpotbugsViolations("")).toEqual([]);
	});
});
