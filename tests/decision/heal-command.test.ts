import { mkdtempSync, mkdirSync, existsSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { DingTalkMessage } from "../../src/notify/dingtalk.js";
import type { DingTalkIncomingMessage } from "../../src/notify/stream-bot.js";
import { DecisionStore } from "../../src/decision/store.js";
import type { DecisionRecord } from "../../src/decision/store.js";
import {
	handleHealCommand,
	type HealCommandDeps,
} from "../../src/decision/heal-command.js";

const event = {
	projectId: "proj-heal",
	pipelineId: 42,
	ref: "main",
	sha: "abcdef1234567890",
	projectUrl: "https://git.example.com/proj-heal",
};

function message(
	text: string,
	overrides: Partial<DingTalkIncomingMessage> = {},
): DingTalkIncomingMessage {
	return {
		text,
		senderStaffId: "staff-1",
		senderNick: "Alice",
		conversationId: "cid-group",
		conversationType: "group",
		sessionWebhook: "https://oapi.dingtalk.com/robot/sendByMsg?session=x",
		robotCode: "robot-001",
		messageId: "msg-001",
		...overrides,
	};
}

describe("handleHealCommand", () => {
	let dir: string;
	let store: DecisionStore;
	let reply: ReturnType<typeof vi.fn>;
	let enqueueResume: ReturnType<typeof vi.fn>;
	let deps: HealCommandDeps;
	let cwd: string;

	beforeEach(() => {
		dir = mkdtempSync(join(tmpdir(), "heal-command-"));
		store = new DecisionStore(join(dir, "decisions.db"));
		reply = vi.fn().mockResolvedValue(undefined);
		enqueueResume = vi.fn().mockResolvedValue(undefined);
		deps = { store, reply, enqueueResume };
		// A retained scene the prod/drop branches clean up.
		cwd = join(dir, "work-42");
		mkdirSync(cwd, { recursive: true });
	});

	afterEach(() => {
		store.close();
		rmSync(dir, { recursive: true, force: true });
	});

	function seedDecision(
		overrides: Partial<{ decision_id: string; status: string }> = {},
	): DecisionRecord {
		const decisionId = overrides.decision_id ?? "D-42-ab12";
		store.create({
			decision_id: decisionId,
			pipeline_id: "42",
			project_id: "proj-heal",
			event_json: JSON.stringify(event),
			cwd_path: cwd,
			session_path: join(cwd, ".pi-agent"),
			branch: "ci-self-heal/main-abcdef12",
			...(overrides.status ? { status: overrides.status as never } : {}),
			expires_at: new Date(Date.now() + 86_400_000).toISOString(),
		});
		const record = store.get(decisionId);
		if (!record) throw new Error("seed failed");
		return record;
	}

	it("returns false for non-/heal text (falls through)", async () => {
		expect(await handleHealCommand(deps, message("/route list"))).toBe(false);
		expect(await handleHealCommand(deps, message("hello"))).toBe(false);
		expect(reply).not.toHaveBeenCalled();
	});

	it("private chat is rejected with a group-only reply, no state change", async () => {
		seedDecision();
		const handled = await handleHealCommand(
			deps,
			message("/heal D-42-ab12 test", { conversationType: "private" }),
		);
		expect(handled).toBe(true);
		expect(reply.mock.calls[0][1].title).toContain("仅支持群聊");
		expect(store.get("D-42-ab12")!.status).toBe("awaiting_decision");
		expect(enqueueResume).not.toHaveBeenCalled();
	});

	it("missing id replies usage without state change", async () => {
		await handleHealCommand(deps, message("/heal"));
		const msg = reply.mock.calls[0][1] as DingTalkMessage;
		expect(msg.text).toContain("/heal");
		expect(enqueueResume).not.toHaveBeenCalled();
	});

	it("unknown decision value replies usage without state change", async () => {
		seedDecision();
		await handleHealCommand(deps, message("/heal D-42-ab12 frobnicate"));
		const msg = reply.mock.calls[0][1] as DingTalkMessage;
		expect(msg.text).toContain("/heal");
		expect(store.get("D-42-ab12")!.status).toBe("awaiting_decision");
		expect(enqueueResume).not.toHaveBeenCalled();
	});

	it("unknown id is rejected with usage", async () => {
		await handleHealCommand(deps, message("/heal D-nope test"));
		const msg = reply.mock.calls[0][1] as DingTalkMessage;
		expect(msg.title).toContain("未找到决策");
		expect(enqueueResume).not.toHaveBeenCalled();
	});

	it("consumed (terminal) decision is rejected, never re-consumed", async () => {
		seedDecision({ status: "closed" });
		await handleHealCommand(deps, message("/heal D-42-ab12 drop"));
		const msg = reply.mock.calls[0][1] as DingTalkMessage;
		expect(msg.title).toContain("决策已处理");
		expect(msg.title).toContain("closed");
		expect(store.get("D-42-ab12")!.status).toBe("closed");
		expect(existsSync(cwd)).toBe(true); // no cleanup re-triggered
	});

	it("valid test decision: resumed + enqueueResume with full record + reply", async () => {
		seedDecision();
		const handled = await handleHealCommand(
			deps,
			message("/heal D-42-ab12 test 断言应按 spec 期望 5"),
		);
		expect(handled).toBe(true);

		const record = store.get("D-42-ab12")!;
		expect(record.status).toBe("resumed");
		expect(record.decided_by).toBe("staff-1");
		expect(record.decision_value).toBe("test");
		expect(record.remark).toBe("断言应按 spec 期望 5");
		expect(record.decided_at).toBeTruthy();

		expect(enqueueResume).toHaveBeenCalledTimes(1);
		const passed = enqueueResume.mock.calls[0][0] as DecisionRecord;
		expect(passed.decision_id).toBe("D-42-ab12");
		expect(passed.cwd_path).toBe(cwd);
		expect(reply.mock.calls[0][1].title).toContain("恢复");
	});

	it("multi-word remark joins tokens with single spaces", async () => {
		seedDecision();
		await handleHealCommand(
			deps,
			message("/heal   D-42-ab12   test   spec   says   five  "),
		);
		expect(store.get("D-42-ab12")!.remark).toBe("spec says five");
	});

	it("enqueueResume failure → compensating revert to awaiting_decision + failure reply", async () => {
		seedDecision();
		enqueueResume.mockRejectedValueOnce(new Error("misconfigured"));
		await handleHealCommand(deps, message("/heal D-42-ab12 test"));

		expect(store.get("D-42-ab12")!.status).toBe("awaiting_decision");
		const msg = reply.mock.calls[0][1] as DingTalkMessage;
		expect(msg.title).toContain("恢复调度失败");
	});

	it("valid prod decision: closed + scene cleaned + human-fix reply", async () => {
		seedDecision();
		await handleHealCommand(deps, message("/heal D-42-ab12 prod"));

		const record = store.get("D-42-ab12")!;
		expect(record.status).toBe("closed");
		expect(record.decided_by).toBe("staff-1");
		expect(record.decision_value).toBe("prod");
		expect(existsSync(cwd)).toBe(false); // cleanupScene removed the scene
		expect(enqueueResume).not.toHaveBeenCalled();
		expect(reply.mock.calls[0][1].title).toContain("源码 bug");
	});

	it("valid drop decision: dropped + scene cleaned", async () => {
		seedDecision();
		await handleHealCommand(deps, message("/heal D-42-ab12 drop"));

		const record = store.get("D-42-ab12")!;
		expect(record.status).toBe("dropped");
		expect(record.decision_value).toBe("drop");
		expect(existsSync(cwd)).toBe(false);
		expect(enqueueResume).not.toHaveBeenCalled();
		expect(reply.mock.calls[0][1].title).toContain("已丢弃");
	});

	it("decidedBy falls back to senderNick when staffId is empty", async () => {
		seedDecision();
		await handleHealCommand(
			deps,
			message("/heal D-42-ab12 drop", { senderStaffId: "" }),
		);
		expect(store.get("D-42-ab12")!.decided_by).toBe("Alice");
	});
});
