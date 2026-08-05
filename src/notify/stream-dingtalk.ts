/**
 * Stream-mode DingTalk notifier — sends group messages via SDK API.
 *
 * Uses the dingtalk-stream SDK's getAccessToken() + DingTalk push API
 * (groupMessages/send) instead of webhook URL POST.
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
	/** Target group conversation ID (openConversationId). Required — notifications go to one group. */
	readonly conversationId: string;
	/** Injectable POST function (defaults to fetch). */
	readonly post?: DingTalkPost;
}

/**
 * Stream-mode notifier that sends markdown messages to a group via DingTalk push API.
 *
 * Uses the dingtalk-stream SDK's getAccessToken() + groupMessages/send instead
 * of the legacy webhook URL POST. The DWClient provides the access token;
 * this notifier handles the REST.
 */
export class StreamDingTalkNotifier implements DingTalkNotifier {
	private readonly client: DWClient;
	private readonly robotCode: string;
	private readonly conversationId: string;
	private readonly post: DingTalkPost;

	constructor(opts: StreamDingTalkNotifierOptions) {
		this.client = opts.client;
		this.robotCode = opts.robotCode;
		this.conversationId = opts.conversationId;
		this.post = opts.post ?? defaultPost;
	}

	async send(message: DingTalkMessage): Promise<void> {
		// Boundary validation: a configured group target is required before
		// hitting the external API (avoids a silent 400 with empty openConversationId).
		if (!this.conversationId) {
			throw new Error(
				"StreamDingTalkNotifier: conversationId is required for group push",
			);
		}

		const token = await this.client.getAccessToken();
		const msgParam = JSON.stringify({
			title: message.title,
			text: `### ${message.title}\n\n${message.text}`,
		});

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
