/**
 * /heal group command — human decision entry for retained escalations (T05).
 *
 *   /heal <id> test|prod|drop [备注]
 *
 *   test — claim the decision as resumed, then schedule the resume worker
 *          against the retained scene (remark injected at resume, T06)
 *   prod — confirm a source-code bug: close the decision, clean the scene,
 *          humans fix the source themselves
 *   drop — discard: drop the decision, clean the scene
 *
 * Group-only (decisions belong to the responsible group, auditable). The
 * decider identity (staffId, nick fallback) is recorded on the decision.
 * Terminal decisions are never re-consumed. Invalid input is rejected with
 * usage — a human must never believe a decision took effect when it didn't.
 *
 * Usage text is injected via deps.usageText from config/command-help.json
 * (T10; single source of truth with /help, same pattern as /route).
 */

import type { DingTalkMessage } from "../notify/dingtalk.js";
import type { DingTalkIncomingMessage } from "../notify/stream-bot.js";
import type { PipelineEvent } from "../types.js";
import { cleanupScene } from "../worker/manager.js";
import { logger } from "../util/log.js";
import type { DecisionRecord, DecisionStore } from "./store.js";

const HEAL_VALUES = ["test", "prod", "drop"] as const;
type HealValue = (typeof HEAL_VALUES)[number];


export interface HealCommandDeps {
	readonly store: DecisionStore;
	/** Send the reply back into the group the command came from. */
	reply(conversationId: string, message: DingTalkMessage): Promise<void>;
	/** Schedule the resume worker for a `test` decision (scheduler.enqueueResume). */
	enqueueResume(record: DecisionRecord): Promise<void>;
	/**
	 * Bulleted usage text for rejection replies — injected from
	 * config/command-help.json (single source of truth with /help).
	 */
	readonly usageText: string;
}

/**
 * Handle a /heal command. Returns true when the message was a /heal command
 * (handled, whether it succeeded or not); false for other text.
 */
export async function handleHealCommand(
	deps: HealCommandDeps,
	message: DingTalkIncomingMessage,
): Promise<boolean> {
	if (!message.text.trim().startsWith("/heal")) return false;

	if (message.conversationType !== "group") {
		await sendReply(deps, message, "决策仅支持群聊");
		return true;
	}

	const args = message.text.trim().split(/\s+/).slice(1);
	const id = args[0];
	const value = args[1] as HealValue | undefined;
	const remark = args.slice(2).join(" ");

	if (!id || !value || !HEAL_VALUES.includes(value)) {
		await sendReply(deps, message, "命令格式不正确。", deps.usageText);
		return true;
	}

	const record = deps.store.get(id);
	if (!record) {
		await sendReply(deps, message, `未找到决策 ${id}`, deps.usageText);
		return true;
	}
	if (record.status !== "awaiting_decision") {
		// Never re-consume a terminal decision.
		await sendReply(deps, message, `决策已处理（当前状态 ${record.status}）`);
		return true;
	}

	const decidedBy = message.senderStaffId || message.senderNick;

	switch (value) {
		case "test": {
			// Claim the decision atomically first, then schedule the resume.
			deps.store.updateStatus(id, {
				status: "resumed",
				decided_by: decidedBy,
				decision_value: "test",
				...(remark ? { remark } : {}),
			});
			try {
				await deps.enqueueResume(record);
			} catch (err) {
				// Compensating write: hand the decision back for a retry.
				deps.store.updateStatus(id, { status: "awaiting_decision" });
				logger.error({ err, decisionId: id }, "resume scheduling failed");
				await sendReply(deps, message, "恢复调度失败，请重试");
				return true;
			}
			await sendReply(
				deps,
				message,
				`✅ 已按测试问题恢复执行（${id}）`,
				"bot 将复用保留的现场继续修复，结果另行通知。",
			);
			return true;
		}
		case "prod": {
			deps.store.updateStatus(id, {
				status: "closed",
				decided_by: decidedBy,
				decision_value: "prod",
				...(remark ? { remark } : {}),
			});
			await cleanupScene(parseEvent(record), record.cwd_path);
			await sendReply(
				deps,
				message,
				"已确认源码 bug，现场已清理，请人工修复源码",
			);
			return true;
		}
		case "drop": {
			deps.store.updateStatus(id, {
				status: "dropped",
				decided_by: decidedBy,
				decision_value: "drop",
				...(remark ? { remark } : {}),
			});
			await cleanupScene(parseEvent(record), record.cwd_path);
			await sendReply(deps, message, "已丢弃，现场已清理");
			return true;
		}
	}
}

/** Event slice stored with the decision (drives cleanupScene's branch/bare paths). */
function parseEvent(record: DecisionRecord): PipelineEvent {
	return JSON.parse(record.event_json) as PipelineEvent;
}

async function sendReply(
	deps: HealCommandDeps,
	message: DingTalkIncomingMessage,
	title: string,
	body?: string,
): Promise<void> {
	await deps.reply(message.conversationId, {
		title,
		text: `### ${title}\n\n${body ?? ""}`,
	});
}
