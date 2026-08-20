import { describe, expect, it } from "vitest";
import { buildSupersedeSteerText } from "../../src/worker/steer-text.js";

describe("buildSupersedeSteerText", () => {
	it("含 old→new sha、变更文件、处置指令", () => {
		const text = buildSupersedeSteerText({
			oldSha: "aaa111",
			newSha: "bbb222",
			newPipelineId: 42,
			changedFiles: ["src/Foo.java", "docs/bar.md"],
		});
		expect(text).toContain("旧 sha: aaa111 → 新 sha: bbb222");
		expect(text).toContain("变更文件: src/Foo.java, docs/bar.md");
		expect(text).toContain("fetch origin");
		expect(text).not.toContain("可收尾");
	});

	it("greenStatus=true 时附可收尾提示", () => {
		const text = buildSupersedeSteerText({
			oldSha: "a",
			newSha: "b",
			newPipelineId: 1,
			greenStatus: true,
		});
		expect(text).toContain("新 pipeline 已绿，可收尾");
	});

	it("无 changedFiles 时使用占位", () => {
		const text = buildSupersedeSteerText({
			oldSha: "a",
			newSha: "b",
			newPipelineId: 1,
		});
		expect(text).toContain("变更文件: （未提供）");
	});
});
