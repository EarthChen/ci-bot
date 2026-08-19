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
		expect(message.text).toContain("项目：proj-A");
		expect(message.text).toContain("分支：main @ abcdef12");
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

	it("非 decidable → 结构化转交消息（标题 + 任务 + 结论）", async () => {
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
				"### 🚨 CI 自愈转交人工",
				"",
				"**任务**",
				"- 项目：proj-A",
				"- 分支：main @ abcdef12",
				"",
				"**结论**",
				"- 转交原因：budget exceeded: total token 200001 exceeded 200000",
				"",
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
				{ ...event, projectUrl: "https://git.example.com/proj-unrouted" },
				{ kind: "escalated", summary: "x" },
			),
		).resolves.toBeUndefined();
		expect(sender.sentGroups).toEqual([]);
	});

	it("/route 通配绑定优先：projectUrl 推导路径命中绑定群（MR !281 场景）", async () => {
		const router = new ProjectRouter({ "ultron/*": "cid-bind" }, "cid-fallback");
		const sender = new InMemoryDingTalkNotifier();
		const notifier = createEscalationNotifier({ router, sender });

		await notifier.notifyEscalated(
			{
				projectId: "31041",
				pipelineId: 100033613,
				ref: "refs/merge-requests/281/head",
				sha: "6722833b7ae56ca7d8e883e939bc586b160b4024",
				projectUrl:
					"https://git.wemomo.com/ultron/ultron-activity-independence",
			},
			{ kind: "escalated", summary: "G3 diff 白名单拦截" },
		);

		expect(sender.sentGroups).toHaveLength(1);
		expect(sender.sentGroups[0].conversationId).toBe("cid-bind");
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
				{ ...event, projectUrl: "https://git.example.com/proj-unrouted" },
				{ kind: "escalated", summary: "x" },
			),
		).resolves.toBeUndefined();
		expect(sender.sentGroups).toEqual([]);
	});

	it("/route 通配绑定优先：终局通知也走 projectUrl 推导的绑定群", async () => {
		const router = new ProjectRouter({ "ultron/*": "cid-bind" }, "");
		const sender = new InMemoryDingTalkNotifier();
		const notifier = createEscalationNotifier({ router, sender });

		await notifier.notifyResumeTerminal(
			{
				projectId: "31041",
				pipelineId: 100033613,
				ref: "refs/merge-requests/281/head",
				sha: "6722833b",
				projectUrl:
					"https://git.wemomo.com/ultron/ultron-activity-independence",
			},
			{ kind: "escalated", summary: "second escalation" },
		);

		expect(sender.sentGroups).toHaveLength(1);
		expect(sender.sentGroups[0].conversationId).toBe("cid-bind");
	});
});


describe("escalation notifier — 结构化消息：任务信息 + 原始播报引用", () => {
	it("outcome 带 agentStats → 消息含模型/轮数/token/session 复用/失败分类", async () => {
		const sender = new InMemoryDingTalkNotifier();
		const router = new ProjectRouter({ "proj-A": "cid-A" }, "");
		const notifier = createEscalationNotifier({ router, sender });
		await notifier.notifyEscalated(event, {
			kind: "escalated",
			summary: "G3/diff 白名单拦截",
			agentStats: {
				model: {
					provider: "amar-coding-plan",
					model: "qwen3.8-max",
					thinkingLevel: "medium",
				},
				turns: 35,
				tokens: 2274826,
				cost: 2.274826,
				durationMs: 391325,
				reusedFromPipeline: 100033121,
				failureClass: 5,
			},
		});
		const text = sender.sentGroups[0].message.text;
		expect(text).toContain("**任务信息**");
		expect(text).toContain(
			"模型：amar-coding-plan/qwen3.8-max（思考深度：medium）",
		);
		expect(text).toContain("轮数：35");
		expect(text).toContain("Tokens：2,274,826");
		expect(text).toContain("Session：复用（源自 pipeline 100033121）");
		expect(text).toContain("失败分类：class 5");
	});

	it("originalBroadcast 提供 → 消息含原始失败播报引用块", async () => {
		const sender = new InMemoryDingTalkNotifier();
		const router = new ProjectRouter({ "proj-A": "cid-A" }, "");
		const notifier = createEscalationNotifier({
			router,
			sender,
			originalBroadcast: (pipelineId) =>
				pipelineId === 42
					? "### ❌ CI Pipeline Failed\n- **项目**: proj-A"
					: undefined,
		});
		await notifier.notifyEscalated(event, { kind: "escalated", summary: "x" });
		const text = sender.sentGroups[0].message.text;
		expect(text).toContain("**原始失败播报**");
		expect(text).toContain("> ### ❌ CI Pipeline Failed");
		expect(text).toContain("> - **项目**: proj-A");
	});

	it("无 agentStats、无 originalBroadcast → 不含任务信息/引用小节", async () => {
		const { notifier, sender } = makeNotifier();
		await notifier.notifyEscalated(event, { kind: "escalated", summary: "x" });
		const text = sender.sentGroups[0].message.text;
		expect(text).not.toContain("**任务信息**");
		expect(text).not.toContain("**原始失败播报**");
	});
});

describe("createEscalationNotifier — G3 扩围（ADR-0009）", () => {
	it("decidable + oosPaths → 决策卡列出可扩围文件 + widen 选项", async () => {
		const { notifier, sender } = makeNotifier();
		await notifier.notifyEscalated(
			event,
			{
				kind: "escalated",
				summary: "G3/diff 违规：patch touches file outside MR diff: m/src/test/T.java",
				decidable: true,
				diagnosisSummary: "class 2 被测代码变更导致测试过时",
				oosPaths: ["m/src/test/T.java", "docs/x.md"],
			},
			{ decisionId: "D-42-ab12", expiresAt: "2026-08-20T00:00:00.000Z" },
		);

		expect(sender.sentGroups).toHaveLength(1);
		const text = sender.sentGroups[0].message.text;
		expect(text).toContain("m/src/test/T.java");
		expect(text).toContain("docs/x.md");
		expect(text).toContain("test|prod|drop|widen");
	});

	it("无 oosPaths 的决策 → 命令行仍是 test|prod|drop，不出现 widen", async () => {
		const { notifier, sender } = makeNotifier();
		await notifier.notifyEscalated(
			event,
			{ kind: "escalated", summary: "x", decidable: true, diagnosisSummary: "y" },
			{ decisionId: "D-42-cd34", expiresAt: "2026-08-20T00:00:00.000Z" },
		);
		const text = sender.sentGroups[0].message.text;
		expect(text).toContain("test|prod|drop [备注]");
		expect(text).not.toContain("widen");
	});
});
