import { describe, expect, it, vi } from "vitest";
import { StreamDingTalkNotifier } from "../../src/notify/stream-dingtalk.js";
import { DingTalkStreamBot } from "../../src/notify/stream-bot.js";
import type { DWClient, DWClientDownStream } from "dingtalk-stream";

describe("StreamDingTalkNotifier", () => {
	it("sends text message via SDK accessToken + groupMessages API", async () => {
		const fakeToken = "fake-token-123";
		const post = vi.fn().mockResolvedValue(undefined);
		const client = {
			getAccessToken: vi.fn().mockResolvedValue(fakeToken),
		} as unknown as DWClient;

		const notifier = new StreamDingTalkNotifier({
			client,
			robotCode: "robot-001",
			post,
		});

		await notifier.send({
			title: "CI 自愈成功",
			text: "项目 proj-1 pipeline 42 修复完成",
		});

		expect(client.getAccessToken).toHaveBeenCalledOnce();
		expect(post).toHaveBeenCalledWith(
			"https://api.dingtalk.com/v1.0/robot/groupMessages/send",
			{
				msgKey: "sampleMarkdown",
				msgParam: expect.stringContaining("CI 自愈成功"),
				robotCode: "robot-001",
				openConversationId: expect.any(String),
			},
			fakeToken,
		);
	});

	it("sends to private chat when conversationId is a user ID", async () => {
		const post = vi.fn().mockResolvedValue(undefined);
		const client = {
			getAccessToken: vi.fn().mockResolvedValue("token"),
		} as unknown as DWClient;

		const notifier = new StreamDingTalkNotifier({
			client,
			robotCode: "robot-001",
			post,
			conversationId: "user-staff-id-123",
			isGroup: false,
		});

		await notifier.send({ title: "test", text: "hello" });

		expect(post).toHaveBeenCalledWith(
			"https://api.dingtalk.com/v1.0/robot/oToMessages/batchSend",
			expect.objectContaining({
				userIds: ["user-staff-id-123"],
				robotCode: "robot-001",
			}),
			"token",
		);
	});
});

describe("DingTalkStreamBot", () => {
	it("registers TOPIC_ROBOT callback and logs received messages", async () => {
		const registerCallback = vi.fn();
		const connect = vi.fn().mockResolvedValue(undefined);
		const disconnect = vi.fn();
		const client = {
			registerCallbackListener: registerCallback.mockReturnThis(),
			registerAllEventListener: vi.fn().mockReturnThis(),
			connect,
			disconnect,
		} as unknown as DWClient;

		const bot = new DingTalkStreamBot({
			client,
			onMessage: vi.fn(),
		});

		await bot.start();

		expect(registerCallback).toHaveBeenCalledWith(
			"/v1.0/im/bot/messages/get",
			expect.any(Function),
		);
		expect(connect).toHaveBeenCalledOnce();
	});

	it("dispatches received message to onMessage callback", async () => {
		const onMessage = vi.fn().mockResolvedValue(undefined);
		let capturedCallback: ((res: DWClientDownStream) => void) | undefined;
		const client = {
			registerCallbackListener: vi.fn((_topic, cb) => {
				capturedCallback = cb;
			}),
			registerAllEventListener: vi.fn().mockReturnThis(),
			connect: vi.fn().mockResolvedValue(undefined),
			disconnect: vi.fn(),
			socketCallBackResponse: vi.fn(),
		} as unknown as DWClient;

		const bot = new DingTalkStreamBot({ client, onMessage });
		await bot.start();

		const fakeDownstream: DWClientDownStream = {
			specVersion: "1.0",
			type: "CALLBACK",
			headers: {
				appId: "app-1",
				connectionId: "conn-1",
				contentType: "application/json",
				messageId: "msg-001",
				time: String(Date.now()),
				topic: "/v1.0/im/bot/messages/get",
			},
			data: JSON.stringify({
				msgtype: "text",
				text: { content: "/status 42" },
				senderStaffId: "user-1",
				senderNick: "Alice",
				conversationId: "conv-1",
				conversationType: "1",
				sessionWebhook: "https://oapi.dingtalk.com/robot/sendByMsg?session=xxx",
				robotCode: "robot-001",
			}),
		};

		capturedCallback!(fakeDownstream);
		await new Promise((r) => setTimeout(r, 10));

		expect(onMessage).toHaveBeenCalledWith(
			expect.objectContaining({
				text: "/status 42",
				senderStaffId: "user-1",
				senderNick: "Alice",
			}),
		);
	});

	it("stops gracefully by calling disconnect", async () => {
		const disconnect = vi.fn();
		const client = {
			registerCallbackListener: vi.fn().mockReturnThis(),
			registerAllEventListener: vi.fn().mockReturnThis(),
			connect: vi.fn().mockResolvedValue(undefined),
			disconnect,
		} as unknown as DWClient;

		const bot = new DingTalkStreamBot({ client, onMessage: vi.fn() });
		await bot.start();
		bot.stop();

		expect(disconnect).toHaveBeenCalledOnce();
	});
});
