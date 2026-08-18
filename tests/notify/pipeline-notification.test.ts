import { describe, expect, it } from "vitest";
import { InMemoryDingTalkNotifier } from "../../src/notify/dingtalk.js";
import {
	buildPipelineNotification,
	createPipelineFailureNotifier,
} from "../../src/notify/pipeline-notification.js";
import { ProjectRouter } from "../../src/notify/project-router.js";

/** Full GitLab pipeline webhook payload (MR-triggered, one failed build). */
function fullPayload(): Record<string, unknown> {
	return {
		object_kind: "pipeline",
		object_attributes: {
			id: 100033121,
			ref: "refs/merge-requests/281/head",
			sha: "8f83b1e0",
			status: "failed",
		},
		project: {
			id: 31041,
			path_with_namespace: "ultron/ultron-activity-independence",
			web_url: "https://git.wemomo.com/ultron/ultron-activity-independence",
		},
		merge_request: {
			iid: 281,
			title: "后台任务玩法",
			url: "https://git.wemomo.com/ultron/ultron-activity-independence/-/merge_requests/281",
			source_branch: "dev-backend-activity",
		},
		commit: {
			author: { name: "earthchen" },
			message: "feat: 条件引擎\n\n详细 body 不应出现",
		},
		builds: [
			{ id: 1001, name: "build-and-test", stage: "build", status: "failed" },
			{ id: 1002, name: "spotless-format", stage: "format", status: "success" },
		],
	};
}

describe("buildPipelineNotification", () => {
	it("renders project/branch/pipeline/MR/committer and failed jobs", () => {
		const notification = buildPipelineNotification(fullPayload());
		expect(notification).not.toBeNull();
		const { title, text } = notification as NonNullable<
			ReturnType<typeof buildPipelineNotification>
		>;

		expect(title).toBe("❌ CI Failed: ultron/ultron-activity-independence");
		expect(text).toContain("### ❌ CI Pipeline Failed");
		expect(text).toContain("- **项目**: ultron/ultron-activity-independence");
		expect(text).toContain("- **分支**: `refs/merge-requests/281/head`");
		expect(text).toContain(
			"[#100033121](https://git.wemomo.com/ultron/ultron-activity-independence/pipelines/100033121)",
		);
		expect(text).toContain("[!281 后台任务玩法]");
		expect(text).toContain("- **提交人**: earthchen");
		expect(text).toContain("**失败 Job (1个)**");
		expect(text).toContain(
			"`build/build-and-test` → [查看日志](https://git.wemomo.com/ultron/ultron-activity-independence/-/jobs/1001)",
		);
		// Successful jobs must not be listed.
		expect(text).not.toContain("spotless-format");
	});

	it("omits the MR line when the payload has no merge_request", () => {
		const payload = fullPayload();
		delete payload.merge_request;

		const notification = buildPipelineNotification(payload);
		expect(notification?.text).not.toContain("**MR**");
	});

	it("caps the failed job list at 5 with an overflow note", () => {
		const payload = fullPayload();
		payload.builds = Array.from({ length: 7 }, (_, i) => ({
			id: 2000 + i,
			name: `job-${i}`,
			stage: "test",
			status: "failed",
		}));

		const { text } = buildPipelineNotification(payload) as { text: string };
		expect(text).toContain("**失败 Job (7个)**");
		expect(text).toContain("job-4");
		expect(text).not.toContain("job-5");
		expect(text).toContain("...(另有 2 个失败 job)");
	});

	it("truncates the commit message to 120 chars", () => {
		const payload = fullPayload();
		(payload.commit as Record<string, unknown>).message = "x".repeat(200);

		const { text } = buildPipelineNotification(payload) as { text: string };
		expect(text).toContain(`- **提交**: ${"x".repeat(120)}\n`);
		expect(text).not.toContain("x".repeat(121));
	});

	it("returns null for a non-object payload", () => {
		expect(buildPipelineNotification(null)).toBeNull();
		expect(buildPipelineNotification("pipeline")).toBeNull();
	});

	it("tolerates missing builds and commit", () => {
		const payload = fullPayload();
		delete payload.builds;
		delete payload.commit;

		const notification = buildPipelineNotification(payload);
		expect(notification?.text).not.toContain("失败 Job");
		expect(notification?.text).toContain("- **提交人**: unknown");
	});
});

describe("createPipelineFailureNotifier", () => {
	it("sends the rendered notification to the routed group", async () => {
		const sender = new InMemoryDingTalkNotifier();
		const router = new ProjectRouter({ "ultron/*": "cid-u" }, "cid-default");
		const notifier = createPipelineFailureNotifier({ router, sender });

		await notifier.notify(fullPayload());

		expect(sender.sentGroups).toHaveLength(1);
		expect(sender.sentGroups[0].conversationId).toBe("cid-u");
		expect(sender.sentGroups[0].message.title).toBe(
			"❌ CI Failed: ultron/ultron-activity-independence",
		);
	});

	it("缺 path_with_namespace 时从 web_url 推导路径命中绑定（绑定优先）", async () => {
		const payload = fullPayload();
		delete (payload.project as Record<string, unknown>).path_with_namespace;
		const sender = new InMemoryDingTalkNotifier();
		const router = new ProjectRouter({ "ultron/*": "cid-u" }, "cid-default");
		const notifier = createPipelineFailureNotifier({ router, sender });

		await notifier.notify(payload);

		expect(sender.sentGroups).toHaveLength(1);
		expect(sender.sentGroups[0].conversationId).toBe("cid-u");
	});

	it("falls back to the default group when no route matches", async () => {
		const sender = new InMemoryDingTalkNotifier();
		const router = new ProjectRouter({ "other/*": "cid-o" }, "cid-default");
		const notifier = createPipelineFailureNotifier({ router, sender });

		await notifier.notify(fullPayload());

		expect(sender.sentGroups[0].conversationId).toBe("cid-default");
	});

	it("skips when no route matches and no default is configured", async () => {
		const sender = new InMemoryDingTalkNotifier();
		const router = new ProjectRouter({ "other/*": "cid-o" }, "");
		const notifier = createPipelineFailureNotifier({ router, sender });

		await notifier.notify(fullPayload());

		expect(sender.sentGroups).toHaveLength(0);
	});

	it("ignores a non-object payload without touching the sender", async () => {
		const sender = new InMemoryDingTalkNotifier();
		const router = new ProjectRouter({}, "cid-default");
		const notifier = createPipelineFailureNotifier({ router, sender });

		await notifier.notify("junk");

		expect(sender.sentGroups).toHaveLength(0);
	});

	it("repair-started 提示 → 卡片尾部追加「已开始修复」（repair=1 入队成功）", async () => {
		const sender = new InMemoryDingTalkNotifier();
		const router = new ProjectRouter({}, "cid-default");
		const notifier = createPipelineFailureNotifier({ router, sender });

		await notifier.notify(fullPayload(), "repair-started");

		expect(sender.sentGroups[0].message.text).toContain(
			"🔧 CI 自愈 bot 已开始修复，完成后将推送结果",
		);
	});

	it("stage-skipped 提示 → 卡片尾部追加「不在自愈范围」", async () => {
		const sender = new InMemoryDingTalkNotifier();
		const router = new ProjectRouter({}, "cid-default");
		const notifier = createPipelineFailureNotifier({ router, sender });

		await notifier.notify(fullPayload(), "stage-skipped");

		expect(sender.sentGroups[0].message.text).toContain(
			"该失败 stage 不在自愈范围（CIHEAL_SKIP_STAGES），不自动修复",
		);
	});

	it("无提示（notify-only/移植原状）→ 卡片不带任何修复尾注", async () => {
		const sender = new InMemoryDingTalkNotifier();
		const router = new ProjectRouter({}, "cid-default");
		const notifier = createPipelineFailureNotifier({ router, sender });

		await notifier.notify(fullPayload());

		expect(sender.sentGroups[0].message.text).not.toContain("自愈 bot");
		expect(sender.sentGroups[0].message.text).not.toContain("不在自愈范围");
	});
});
