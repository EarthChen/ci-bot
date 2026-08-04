/**
 * DingTalk notifier — deterministic notification channel driven by bot code.
 *
 * Per G2: the agent NEVER holds the DingTalk tool. Only bot code calls it,
 * at deterministic pipeline nodes (fix success / escalation / flaky / bot fault).
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
  async send(message: DingTalkMessage): Promise<void> {
    this.sent.push(message);
  }
}

/**
 * HTTP notifier that POSTs to the DingTalk custom-bot webhook URL.
 *
 * The real signer (timestamp + HMAC-SHA256 with secret) is implemented in
 * ticket 02+; for the tracer bullet we send an unmarked text message so the
 * e2e seam observes "a DingTalk HTTP call with the right content" without
 * coupling to signing internals.
 */
export class HttpDingTalkNotifier implements DingTalkNotifier {
  constructor(
    private readonly webhookUrl: string,
    private readonly post: (url: string, body: unknown) => Promise<void>,
  ) {}
  async send(message: DingTalkMessage): Promise<void> {
    await this.post(this.webhookUrl, {
      msgtype: "text",
      text: { content: `${message.title}\n${message.text}` },
    });
  }
}
