import { describe, expect, it } from "vitest";
import { createEscalationNotifier } from "../../src/notify/escalation-notifier.js";
import { ProjectRouter } from "../../src/notify/project-router.js";
import { InMemoryDingTalkNotifier } from "../../src/notify/dingtalk.js";
import type { PipelineEvent } from "../../src/types.js";

const event: PipelineEvent = {
	projectId: "proj-A",
	pipelineId: 42,
	ref: "main",
	sha: "abcdef1234567890",
	projectUrl: "https://git.example.com/proj-A",
};

/** Static route for proj-A; empty default → other projects resolve to null. */
function makeNotifier() {
	const router = new ProjectRouter({ "proj-A": "cid-A" }, "");
	const sender = new InMemoryDingTalkNotifier();
	const notifier = createEscalationNotifier({ router, sender });
	return { notifier, sender };
}

describe("createEscalationNotifier — routed escalation 通知", () => {
	it("decidable + decision → 待决策消息（id + /heal 模板 + 过期 + 诊断摘要），路由到项目群", async () => {
		const { notifier, sender } = makeNotifier();
		await notifier.notifyEscalated(
			event,
			{
				kind: "escalated",
				summary: "need human decision",
				decidable: true,
				diagnosisSummary: "spec unreadable",
			},
			{ decisionId: "D-42-ab12", expiresAt: "2026-08-18T11:00:00.000Z" },
		);

		expect(sender.sentGroups).toHaveLength(1);
		const { conversationId, message } = sender.sentGroups[0];
		expect(conversationId).toBe("cid-A");
		expect(message.title).toBe("CI 自愈待人工决策");
		expect(message.text).toContain("项目 proj-A");
		expect(message.text).toContain("分支 main @ abcdef12");
		expect(message.text).toContain("spec unreadable");
		expect(message.text).toContain("D-42-ab12");
		expect(message.text).toContain("/heal D-42-ab12 test|prod|drop");
		expect(message.text).toContain("2026-08-18T11:00:00.000Z");
	});

	it("非 decidable → 与原 worker 通知内容一致（仅投递路径变化）", async () => {
		const { notifier, sender } = makeNotifier();
		await notifier.notifyEscalated(event, {
			kind: "escalated",
			summary: "budget exceeded: total token 200001 exceeded 200000",
		});

		expect(sender.sentGroups).toHaveLength(1);
		const { conversationId, message } = sender.sentGroups[0];
		expect(conversationId).toBe("cid-A");
		expect(message.title).toBe("CI 自愈转交人工");
		expect(message.text).toBe(
			[
				"项目 proj-A",
				"分支 main @ abcdef12",
				"原因：budget exceeded: total token 200001 exceeded 200000",
			].join("\n"),
		);
	});

	it("decidable 但无 decision（注册失败降级）→ 普通转交消息", async () => {
		const { notifier, sender } = makeNotifier();
		await notifier.notifyEscalated(
			event,
			{
				kind: "escalated",
				summary: "need human decision",
				decidable: true,
				diagnosisSummary: "spec unreadable",
			},
			undefined,
		);

		expect(sender.sentGroups).toHaveLength(1);
		expect(sender.sentGroups[0].message.title).toBe("CI 自愈转交人工");
	});

	it("项目无路由 → 不发送、不抛错", async () => {
		const { notifier, sender } = makeNotifier();
		await expect(
			notifier.notifyEscalated(
				{ ...event, projectId: "proj-unrouted" },
				{ kind: "escalated", summary: "x" },
			),
		).resolves.toBeUndefined();
		expect(sender.sentGroups).toEqual([]);
	});
});
