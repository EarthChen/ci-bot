import { describe, expect, it } from "vitest";
import { CI_REPAIR_SCHEDULING_POLICY } from "../../src/agent/ci-repair-definition.js";
import type { PipelineEvent } from "../../src/types.js";

function ev(over: Partial<PipelineEvent>): PipelineEvent {
	return {
		projectId: "31041",
		pipelineId: 1,
		ref: "refs/merge-requests/281/head",
		sha: "abc1234567890",
		projectUrl: "https://git.example.com/g/p",
		...over,
	};
}

describe("CI_REPAIR_SCHEDULING_POLICY.serialKey — 同项目多 MR 并发", () => {
	it("同项目不同 MR → 不同 key（可并行）", () => {
		const a = CI_REPAIR_SCHEDULING_POLICY.serialKey(ev({ mrIid: 281 }));
		const b = CI_REPAIR_SCHEDULING_POLICY.serialKey(ev({ mrIid: 282 }));
		expect(a).not.toBe(b);
	});

	it("同项目同 MR → 同 key（重复 pipeline / resume 串行）", () => {
		const a = CI_REPAIR_SCHEDULING_POLICY.serialKey(
			ev({ mrIid: 281, pipelineId: 1 }),
		);
		const b = CI_REPAIR_SCHEDULING_POLICY.serialKey(
			ev({ mrIid: 281, pipelineId: 2 }),
		);
		expect(a).toBe(b);
	});

	it("无 mrIid（分支 push pipeline）→ 回退 ref 参与 key", () => {
		const a = CI_REPAIR_SCHEDULING_POLICY.serialKey(
			ev({ ref: "master", pipelineId: 1 }),
		);
		const b = CI_REPAIR_SCHEDULING_POLICY.serialKey(
			ev({ ref: "master", pipelineId: 2 }),
		);
		const c = CI_REPAIR_SCHEDULING_POLICY.serialKey(
			ev({ ref: "dev", pipelineId: 3 }),
		);
		expect(a).toBe(b);
		expect(a).not.toBe(c);
	});

	it("不同项目永不共享 key", () => {
		const a = CI_REPAIR_SCHEDULING_POLICY.serialKey(
			ev({ projectId: "X", mrIid: 1 }),
		);
		const b = CI_REPAIR_SCHEDULING_POLICY.serialKey(
			ev({ projectId: "Y", mrIid: 1 }),
		);
		expect(a).not.toBe(b);
	});
});
