/**
 * Stream-mode DingTalk notifier — sends messages via SDK API.
 *
 * Uses the dingtalk-stream SDK's getAccessToken() + DingTalk push API
 * (groupMessages/send or oToMessages/batchSend) instead of webhook URL POST.
 *
 * Per G2: the agent NEVER holds the DingTalk tool. Only bot code calls it,
 * at deterministic pipeline nodes (fix success / escalation / flaky / bot fault).
 */

import type { DWClient } from "dingtalk-stream";
import type { DingTalkMessage, DingTalkNotifier } from "./dingtalk.js";

const DINGTALK_API_BASE = "https://api.dingtalk.com";

/** Injectable HTTP POST function (fetch wrapper for tests). */
export type DingTalkPost = (
	url: string,
	body: unknown,
	accessToken: string,
) => Promise<void>;

export interface StreamDingTalkNotifierOptions {
	/** SDK client (provides getAccessToken). */
	readonly client: DWClient;
	/** Robot code (AppKey / clientId). */
	readonly robotCode: string;
	/** Target conversation ID (group openConversationId or user staffId). */
	readonly conversationId?: string;
	/** Whether the conversationId is a group (default true). */
	readonly isGroup?: boolean;
	/** Injectable POST function (defaults to fetch). */
	readonly post?: DingTalkPost;
}

/**
 * Stream-mode notifier that sends markdown messages via DingTalk push API.
 *
 * Replaces HttpDingTalkNotifier (webhook URL POST) with SDK API calls.
 * The DWClient provides the access token; this notifier handles the REST.
 */
export class StreamDingTalkNotifier implements DingTalkNotifier {
	private readonly client: DWClient;
	private readonly robotCode: string;
	private readonly conversationId: string;
	private readonly isGroup: boolean;
	private readonly post: DingTalkPost;

	constructor(opts: StreamDingTalkNotifierOptions) {
		this.client = opts.client;
		this.robotCode = opts.robotCode;
		this.conversationId = opts.conversationId ?? "";
		this.isGroup = opts.isGroup ?? true;
		this.post = opts.post ?? defaultPost;
	}

	async send(message: DingTalkMessage): Promise<void> {
		const token = await this.client.getAccessToken();
		const msgParam = JSON.stringify({
			title: message.title,
			text: `### ${message.title}\n\n${message.text}`,
		});

		if (this.isGroup) {
			await this.post(
				`${DINGTALK_API_BASE}/v1.0/robot/groupMessages/send`,
				{
					msgKey: "sampleMarkdown",
					msgParam,
					robotCode: this.robotCode,
					openConversationId: this.conversationId,
				},
				token,
			);
		} else {
			await this.post(
				`${DINGTALK_API_BASE}/v1.0/robot/oToMessages/batchSend`,
				{
					msgKey: "sampleMarkdown",
					msgParam,
					robotCode: this.robotCode,
					userIds: [this.conversationId],
				},
				token,
			);
		}
	}
}

/** Default fetch-based POST implementation. */
async function defaultPost(
	url: string,
	body: unknown,
	accessToken: string,
): Promise<void> {
	const res = await fetch(url, {
		method: "POST",
		headers: {
			"content-type": "application/json",
			"x-acs-dingtalk-access-token": accessToken,
		},
		body: JSON.stringify(body),
	});
	if (!res.ok) {
		throw new Error(`dingtalk api failed: ${res.status} ${res.statusText}`);
	}
}
