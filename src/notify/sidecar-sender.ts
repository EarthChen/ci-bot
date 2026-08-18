/**
 * 主进程 fake 模式的钉钉记录 seam（GroupMessageSender 实现）。
 *
 * Run-6 缺口：fake 模式下主进程用 InMemoryDingTalkNotifier，失败播报、
 * 转交卡的内容随进程消失，e2e 无法验证任何通知。本 sender 把每张卡片
 * 追加为一条 jsonl 记录（DATA_ROOT/logs/dingtalk-fake.jsonl），与 worker
 * 侧 dingtalk-sent.json sidecar 约定对齐（跨进程可观测）。
 */
import { appendFileSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";
import type { DingTalkMessage } from "./dingtalk.js";
import type { GroupMessageSender } from "./pipeline-notification.js";

export class SidecarGroupSender implements GroupMessageSender {
	constructor(private readonly path: string) {}

	async sendTo(
		conversationId: string,
		message: DingTalkMessage,
	): Promise<void> {
		mkdirSync(dirname(this.path), { recursive: true });
		appendFileSync(
			this.path,
			`${JSON.stringify({
				ts: new Date().toISOString(),
				conversationId,
				title: message.title,
				text: message.text,
			})}\n`,
			"utf8",
		);
	}
}
