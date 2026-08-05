/**
 * DingTalk Stream Bot — WebSocket-based message receiver.
 *
 * Wraps the dingtalk-stream SDK's DWClient to:
 *   - Register TOPIC_ROBOT callback for incoming @bot messages
 *   - Parse and dispatch messages to an onMessage handler
 *   - Provide start/stop lifecycle for the main process
 *
 * First version: logs received messages and forwards to onMessage callback.
 * Command handler registration is extensible via the onMessage callback.
 */

import {
	type DWClient,
	type DWClientDownStream,
	type RobotMessage,
	TOPIC_ROBOT,
	EventAck,
} from "dingtalk-stream";
import { logger } from "../util/log.js";

/** Conversation type derived from DingTalk's "1" (private) / "2" (group). */
export type ConversationType = "private" | "group";

/** Parsed incoming message delivered to the onMessage callback. */
export interface DingTalkIncomingMessage {
	/** Raw text content (e.g. "/status 42"). */
	readonly text: string;
	/** Sender staff ID (for identifying the sender). */
	readonly senderStaffId: string;
	/** Sender nickname. */
	readonly senderNick: string;
	/** Conversation ID (openConversationId for groups). */
	readonly conversationId: string;
	/** "private" (1:1) or "group". */
	readonly conversationType: ConversationType;
	/** Session webhook URL for direct reply. */
	readonly sessionWebhook: string;
	/** Robot code. */
	readonly robotCode: string;
	/** Message ID (for ACK). */
	readonly messageId: string;
}

/** Handler for incoming @bot messages. */
export type MessageHandler = (
	message: DingTalkIncomingMessage,
) => Promise<void>;

export interface DingTalkStreamBotOptions {
	/** SDK client (DWClient instance). */
	readonly client: DWClient;
	/** Callback for received messages (first version: logging only). */
	readonly onMessage: MessageHandler;
}

/**
 * Stream-mode DingTalk bot — receives messages via WebSocket.
 *
 * Lives in the main process (long-lived). Worker subprocesses use
 * StreamDingTalkNotifier for one-way push; they don't need WebSocket.
 */
export class DingTalkStreamBot {
	private readonly client: DWClient;
	private readonly onMessage: MessageHandler;

	constructor(opts: DingTalkStreamBotOptions) {
		this.client = opts.client;
		this.onMessage = opts.onMessage;
	}

	/** Start the WebSocket connection and register callbacks. */
	async start(): Promise<void> {
		this.client.registerCallbackListener(TOPIC_ROBOT, (res) => {
			void this.handleIncoming(res).catch((err) => {
				logger.error({ err }, "dingtalk message handler error");
			});
		});

		this.client.registerAllEventListener(() => ({ status: EventAck.SUCCESS }));

		await this.client.connect();
		logger.info("dingtalk stream bot started");
	}

	/** Stop the WebSocket connection. */
	stop(): void {
		this.client.disconnect();
		logger.info("dingtalk stream bot stopped");
	}

	/** Parse downstream message and dispatch to onMessage. ACKs unconditionally. */
	private async handleIncoming(res: DWClientDownStream): Promise<void> {
		const messageId = res.headers.messageId;
		try {
			let raw: RobotMessage;
			try {
				raw = JSON.parse(res.data) as RobotMessage;
			} catch (err) {
				logger.warn({ err, messageId }, "dingtalk message parse failed");
				return; // malformed payload — drop, ACK in finally
			}

			const text = raw.text?.content?.trim() ?? "";
			if (!text) return; // empty content — drop, ACK in finally

			const message: DingTalkIncomingMessage = {
				text,
				senderStaffId: raw.senderStaffId,
				senderNick: raw.senderNick,
				conversationId: raw.conversationId,
				conversationType: raw.conversationType === "2" ? "group" : "private",
				sessionWebhook: raw.sessionWebhook,
				robotCode: raw.robotCode,
				messageId,
			};

			await this.onMessage(message);
		} finally {
			// ACK unconditionally so DingTalk never retries a message we have
			// already accepted (parse failure or handler error included).
			this.client.socketCallBackResponse(messageId, {});
		}
	}
}
