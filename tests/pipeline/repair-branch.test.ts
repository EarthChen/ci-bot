import { describe, it, expect } from "vitest";
import { repairBranchName } from "../../src/pipeline/repair-branch.js";
import { REPAIR_BRANCH_PREFIX } from "../../src/pipeline/worktree.js";
import type { PipelineEvent } from "../../src/types.js";

const base: PipelineEvent = {
	projectId: "42",
	pipelineId: 1001,
	ref: "main",
	sha: "abc1234567890",
	projectUrl: "https://git.example.com/g/p",
};

describe("repairBranchName", () => {
	it("MR 事件按 mrSourceBranch 收敛分支名", () => {
		const event: PipelineEvent = {
			...base,
			mrIid: 42,
			mrSourceBranch: "feature/foo",
		};
		expect(repairBranchName(event)).toBe(`${REPAIR_BRANCH_PREFIX}feature/foo`);
	});

	it("非 MR 事件保持 ref-sha8 格式（向后兼容）", () => {
		expect(repairBranchName(base)).toBe(`${REPAIR_BRANCH_PREFIX}main-abc12345`);
	});
});
