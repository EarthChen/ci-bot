import { describe, expect, it, vi } from "vitest";
import type { DingTalkMessage } from "../../src/notify/dingtalk.js";
import type { CommandHelpConfig } from "../../src/notify/command-help.js";
import {
	handleHelpCommand,
	type HelpCommandDeps,
} from "../../src/notify/help-command.js";
import type { DingTalkIncomingMessage } from "../../src/notify/stream-bot.js";

const HELP_CONFIG: CommandHelpConfig = {
	commands: {
		"/route": { summary: "管理群路由", usage: ["`/route add <pattern>` 绑定当前群"] },
		"/help": { summary: "显示本帮助", usage: ["`/help` 列出所有命令"] },
	},
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

function deps(help: CommandHelpConfig = HELP_CONFIG): {
	deps: HelpCommandDeps;
	reply: ReturnType<typeof vi.fn>;
} {
	const reply = vi.fn().mockResolvedValue(undefined);
	return { deps: { help, reply }, reply };
}

describe("handleHelpCommand", () => {
	it("returns false for non-/help text", async () => {
		const { deps: d, reply } = deps();
		expect(await handleHelpCommand(d, message("/route list"))).toBe(false);
		expect(reply).not.toHaveBeenCalled();
	});

	it("lists every registered command with its summary", async () => {
		const { deps: d, reply } = deps();

		expect(await handleHelpCommand(d, message("/help"))).toBe(true);

		const msg = reply.mock.calls[0][1] as DingTalkMessage;
		expect(reply.mock.calls[0][0]).toBe("cid-group");
		expect(msg.text).toContain("/route");
		expect(msg.text).toContain("管理群路由");
		expect(msg.text).toContain("/help");
	});

	it("shows one command's detail, accepting the bare name", async () => {
		const { deps: d, reply } = deps();

		await handleHelpCommand(d, message("/help route"));

		const msg = reply.mock.calls[0][1] as DingTalkMessage;
		expect(msg.title).toBe("/route");
		expect(msg.text).toContain("`/route add <pattern>` 绑定当前群");
	});

	it("replies with the index for an unknown command (still handled)", async () => {
		const { deps: d, reply } = deps();

		await handleHelpCommand(d, message("/help /frobnicate"));

		const msg = reply.mock.calls[0][1] as DingTalkMessage;
		expect(msg.title).toContain("未知命令");
		expect(msg.text).toContain("/route");
	});

	it("is dropped silently in private chats (no group reply seam in v1)", async () => {
		const { deps: d, reply } = deps();

		const handled = await handleHelpCommand(
			d,
			message("/help", { conversationType: "private" }),
		);

		expect(handled).toBe(true);
		expect(reply).not.toHaveBeenCalled();
	});
});
