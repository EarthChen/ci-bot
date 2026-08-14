import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { DingTalkMessage } from "../../src/notify/dingtalk.js";
import {
	handleRouteCommand,
	type RouteCommandDeps,
} from "../../src/notify/route-command.js";
import { WebhookRouteStore } from "../../src/notify/route-store.js";
import type { DingTalkIncomingMessage } from "../../src/notify/stream-bot.js";

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

describe("handleRouteCommand", () => {
	let dir: string;
	let store: WebhookRouteStore;
	let reply: ReturnType<typeof vi.fn>;
	let deps: RouteCommandDeps;

	beforeEach(() => {
		dir = mkdtempSync(join(tmpdir(), "route-command-"));
		store = new WebhookRouteStore(join(dir, "routes.db"));
		reply = vi.fn().mockResolvedValue(undefined);
		deps = {
			store,
			reply,
			usageText:
				"用法：\n- `/route add <pattern>` 绑定当前群\n- `/route rm <pattern>` 删除路由",
		};
	});

	afterEach(() => {
		store.close();
		rmSync(dir, { recursive: true, force: true });
	});

	it("returns false for non-/route text (falls through to other handlers)", async () => {
		expect(await handleRouteCommand(deps, message("/status 42"))).toBe(false);
		expect(await handleRouteCommand(deps, message("hello"))).toBe(false);
		expect(reply).not.toHaveBeenCalled();
	});

	it("add binds the pattern to the current group and records the sender", async () => {
		const handled = await handleRouteCommand(
			deps,
			message("/route add ultron/*"),
		);

		expect(handled).toBe(true);
		expect(store.getMapping()).toEqual({ "ultron/*": "cid-group" });
		expect(store.list()[0].createdBy).toBe("staff-1");
		expect(reply).toHaveBeenCalledWith(
			"cid-group",
			expect.objectContaining({ title: expect.stringContaining("ultron/*") }),
		);
	});

	it("add without a pattern replies usage instead of writing", async () => {
		await handleRouteCommand(deps, message("/route add"));

		expect(store.getMapping()).toEqual({});
		expect(reply).toHaveBeenCalledWith(
			"cid-group",
			expect.objectContaining({ text: expect.stringContaining("/route add") }),
		);
	});

	it("add in a private chat is dropped without writing (no group to bind)", async () => {
		const handled = await handleRouteCommand(
			deps,
			message("/route add ultron/*", { conversationType: "private" }),
		);

		expect(handled).toBe(true);
		expect(store.getMapping()).toEqual({});
		expect(reply).not.toHaveBeenCalled();
	});

	it("rm deletes an existing route and confirms", async () => {
		store.add("ultron/*", "cid-group", "staff-1");

		await handleRouteCommand(deps, message("/route rm ultron/*"));

		expect(store.getMapping()).toEqual({});
		expect(reply).toHaveBeenCalledWith(
			"cid-group",
			expect.objectContaining({ title: expect.stringContaining("已删除") }),
		);
	});

	it("rm of a missing route warns without throwing", async () => {
		await handleRouteCommand(deps, message("/route rm nope"));

		expect(reply).toHaveBeenCalledWith(
			"cid-group",
			expect.objectContaining({ title: expect.stringContaining("未找到") }),
		);
	});

	it("list renders every dynamic route with pattern and target", async () => {
		store.add("a/*", "cid-a", "x");
		store.add("b/c", "cid-b", "y");

		await handleRouteCommand(deps, message("/route list"));

		const msg = reply.mock.calls[0][1] as DingTalkMessage;
		expect(msg.text).toContain("a/*");
		expect(msg.text).toContain("cid-a");
		expect(msg.text).toContain("b/c");
	});

	it("list of an empty store says so", async () => {
		await handleRouteCommand(deps, message("/route list"));

		const msg = reply.mock.calls[0][1] as DingTalkMessage;
		expect(msg.title).toContain("为空");
	});

	it("unknown subcommand replies usage", async () => {
		await handleRouteCommand(deps, message("/route frobnicate"));

		expect(reply).toHaveBeenCalledWith(
			"cid-group",
			expect.objectContaining({ text: expect.stringContaining("/route add") }),
		);
	});
});
