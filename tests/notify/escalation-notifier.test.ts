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

	it("escalated 带部分修复 MR → 待决策消息含 MR 链接（MR !281 需求）", async () => {
		const { notifier, sender } = makeNotifier();
		await notifier.notifyEscalated(
			event,
			{
				kind: "escalated",
				summary: "class 3 转交",
				decidable: true,
				diagnosisSummary: "根因在 src/main",
				mrUrl: "https://git.example.com/proj-A/-/merge_requests/77",
			},
			{ decisionId: "D-42-ab12", expiresAt: "2026-08-18T11:00:00.000Z" },
		);
		expect(sender.sentGroups[0].message.text).toContain(
			"MR（部分修复）：https://git.example.com/proj-A/-/merge_requests/77",
		);
	});

	it("非 decidable 带部分修复 MR → 转交消息含 MR 链接", async () => {
		const { notifier, sender } = makeNotifier();
		await notifier.notifyEscalated(event, {
			kind: "escalated",
			summary: "budget exceeded",
			mrUrl: "https://git.example.com/proj-A/-/merge_requests/78",
		});
		expect(sender.sentGroups[0].message.text).toContain(
			"MR（部分修复）：https://git.example.com/proj-A/-/merge_requests/78",
		);
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

describe("notifyResumeTerminal — 二次转交终局通知（T09）", () => {
	it("终局消息路由到项目群：标题 + 原因 + 人工接手说明", async () => {
		const { notifier, sender } = makeNotifier();
		await notifier.notifyResumeTerminal(event, {
			kind: "escalated",
			summary: "second escalation",
		});

		expect(sender.sentGroups).toHaveLength(1);
		const { conversationId, message } = sender.sentGroups[0];
		expect(conversationId).toBe("cid-A");
		expect(message.title).toBe("CI 自愈二次转交（终局）");
		expect(message.text).toContain("proj-A");
		expect(message.text).toContain("main @ abcdef12");
		expect(message.text).toContain("原因：second escalation");
		expect(message.text).toContain("人工介入后仍无法修复");
	});

	it("项目无路由 → 不发送、不抛错", async () => {
		const { notifier, sender } = makeNotifier();
		await expect(
			notifier.notifyResumeTerminal(
				{ ...event, projectId: "proj-unrouted" },
				{ kind: "escalated", summary: "x" },
			),
		).resolves.toBeUndefined();
		expect(sender.sentGroups).toEqual([]);
	});
});
