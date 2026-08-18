import { describe, expect, it } from "vitest";
import { projectPathFromUrl } from "../../src/notify/project-router.js";

describe("projectPathFromUrl — GitLab 项目 URL → group/project 路径", () => {
	it("标准项目主页 URL", () => {
		expect(
			projectPathFromUrl(
				"https://git.wemomo.com/ultron/ultron-activity-independence",
			),
		).toBe("ultron/ultron-activity-independence");
	});

	it("去掉 .git 后缀", () => {
		expect(
			projectPathFromUrl(
				"https://git.wemomo.com/ultron/ultron-activity-independence.git",
			),
		).toBe("ultron/ultron-activity-independence");
	});

	it("去掉末尾斜杠", () => {
		expect(
			projectPathFromUrl(
				"https://git.wemomo.com/ultron/ultron-activity-independence/",
			),
		).toBe("ultron/ultron-activity-independence");
	});

	it("无 scheme 的 URL（防御）", () => {
		expect(
			projectPathFromUrl("git.wemomo.com/ultron/ultron-activity-independence"),
		).toBe("ultron/ultron-activity-independence");
	});

	it("host 直根（无路径）→ 空串", () => {
		expect(projectPathFromUrl("https://git.wemomo.com")).toBe("");
		expect(projectPathFromUrl("")).toBe("");
	});
});