/**
 * DingTalk notifier — deterministic notification channel driven by bot code.
 *
 * Per G2: the agent NEVER holds the DingTalk tool. Only bot code calls it,
 * at deterministic pipeline nodes (fix success / escalation / flaky / bot fault).
 *
 * Production implementations live in `stream-dingtalk.ts` (API push) and
 * `stream-bot.ts` (WebSocket receiver); this module holds the shared contract
 * plus the in-memory recorder used by tests.
 */

export interface DingTalkMessage {
	readonly title: string;
	readonly text: string;
}

export interface DingTalkNotifier {
	/** Send a notification. Resolves on success; rejects on transport failure. */
	send(message: DingTalkMessage): Promise<void>;
}

/** Simple in-memory notifier that records calls (for tests / dry-run). */
export class InMemoryDingTalkNotifier implements DingTalkNotifier {
	readonly sent: DingTalkMessage[] = [];
	/** Group-targeted sends recorded with their conversation id (tests / dry-run). */
	readonly sentGroups: Array<{
		readonly conversationId: string;
		readonly message: DingTalkMessage;
	}> = [];

	async send(message: DingTalkMessage): Promise<void> {
		this.sent.push(message);
	}

	async sendTo(
		conversationId: string,
		message: DingTalkMessage,
	): Promise<void> {
		this.sentGroups.push({ conversationId, message });
	}
}
