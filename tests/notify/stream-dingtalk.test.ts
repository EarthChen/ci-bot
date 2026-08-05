import { describe, expect, it, vi } from "vitest";
import { StreamDingTalkNotifier } from "../../src/notify/stream-dingtalk.js";
import { DingTalkStreamBot } from "../../src/notify/stream-bot.js";
import { TOPIC_ROBOT } from "dingtalk-stream";
import type { DWClient, DWClientDownStream } from "dingtalk-stream";

function fakeDownstream(content: string): DWClientDownStream {
	return {
		specVersion: "1.0",
		type: "CALLBACK",
		headers: {
			appId: "app-1",
			connectionId: "conn-1",
			contentType: "application/json",
			messageId: "msg-001",
			time: String(Date.now()),
			topic: TOPIC_ROBOT,
		},
		data: JSON.stringify({
			msgtype: "text",
			text: { content },
			senderStaffId: "user-1",
			senderNick: "Alice",
			conversationId: "conv-1",
			conversationType: "2",
			sessionWebhook: "https://oapi.dingtalk.com/robot/sendByMsg?session=xxx",
			robotCode: "robot-001",
		}),
	};
}

describe("StreamDingTalkNotifier", () => {
	it("sends group message via SDK accessToken + groupMessages API", async () => {
		const fakeToken = "fake-token-123";
		const post = vi.fn().mockResolvedValue(undefined);
		const client = {
			getAccessToken: vi.fn().mockResolvedValue(fakeToken),
		} as unknown as DWClient;

		const notifier = new StreamDingTalkNotifier({
			client,
			robotCode: "robot-001",
			conversationId: "conv-1",
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
				openConversationId: "conv-1",
			},
			fakeToken,
		);
	});

	it("throws when group conversationId is empty (boundary validation)", async () => {
		const client = {
			getAccessToken: vi.fn().mockResolvedValue("token"),
		} as unknown as DWClient;

		const notifier = new StreamDingTalkNotifier({
			client,
			robotCode: "robot-001",
			conversationId: "",
		});

		await expect(
			notifier.send({ title: "test", text: "hello" }),
		).rejects.toThrow(/conversationId/i);
	});
});

describe("DingTalkStreamBot", () => {
	it("registers TOPIC_ROBOT callback and connects", async () => {
		const registerCallback = vi.fn();
		const connect = vi.fn().mockResolvedValue(undefined);
		const disconnect = vi.fn();
		const client = {
			registerCallbackListener: registerCallback.mockReturnThis(),
			registerAllEventListener: vi.fn().mockReturnThis(),
			connect,
			disconnect,
		} as unknown as DWClient;

		const bot = new DingTalkStreamBot({ client, onMessage: vi.fn() });
		await bot.start();

		expect(registerCallback).toHaveBeenCalledWith(
			TOPIC_ROBOT,
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

		capturedCallback!(fakeDownstream("/status 42"));
		await new Promise((r) => setTimeout(r, 10));

		expect(onMessage).toHaveBeenCalledWith(
			expect.objectContaining({
				text: "/status 42",
				senderStaffId: "user-1",
				senderNick: "Alice",
				conversationType: "group",
			}),
		);
	});

	it("acks the message even when onMessage throws (no infinite retry)", async () => {
		const onMessage = vi.fn().mockRejectedValue(new Error("handler boom"));
		let capturedCallback: ((res: DWClientDownStream) => void) | undefined;
		const socketCallBackResponse = vi.fn();
		const client = {
			registerCallbackListener: vi.fn((_topic, cb) => {
				capturedCallback = cb;
			}),
			registerAllEventListener: vi.fn().mockReturnThis(),
			connect: vi.fn().mockResolvedValue(undefined),
			disconnect: vi.fn(),
			socketCallBackResponse,
		} as unknown as DWClient;

		const bot = new DingTalkStreamBot({ client, onMessage });
		await bot.start();

		capturedCallback!(fakeDownstream("/status 42"));
		await new Promise((r) => setTimeout(r, 10));

		expect(socketCallBackResponse).toHaveBeenCalledWith("msg-001", {});
	});

	it("acks even when payload is malformed (no infinite retry)", async () => {
		const onMessage = vi.fn();
		let capturedCallback: ((res: DWClientDownStream) => void) | undefined;
		const socketCallBackResponse = vi.fn();
		const client = {
			registerCallbackListener: vi.fn((_topic, cb) => {
				capturedCallback = cb;
			}),
			registerAllEventListener: vi.fn().mockReturnThis(),
			connect: vi.fn().mockResolvedValue(undefined),
			disconnect: vi.fn(),
			socketCallBackResponse,
		} as unknown as DWClient;

		const bot = new DingTalkStreamBot({ client, onMessage });
		await bot.start();

		const broken = {
			...fakeDownstream("/status 42"),
			data: "not-json",
		};
		capturedCallback!(broken);
		await new Promise((r) => setTimeout(r, 10));

		expect(socketCallBackResponse).toHaveBeenCalledWith("msg-001", {});
		expect(onMessage).not.toHaveBeenCalled();
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
