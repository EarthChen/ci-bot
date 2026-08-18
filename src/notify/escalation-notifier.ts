/**
 * Routed escalation notifications — main process only (T04).
 *
 * ALL escalated notifications moved here from the worker process: the worker
 * only reports the outcome; the main process resolves the project's routed
 * group via ProjectRouter (same group as the webhook failure broadcast) and
 * sends via GroupMessageSender.
 *
 * Two message shapes:
 *   - decidable + decision registered: "CI 自愈待人工决策" with diagnosis
 *     summary, decision id, copy-paste /heal command template, expiry time
 *   - non-decidable (or registration failed — degraded path): the plain
 *     "CI 自愈转交人工" handoff message (content identical to the old
 *     worker-side notifyEscalation; only the delivery path changed)
 */

import type { DingTalkMessage } from "./dingtalk.js";
import type { ProjectRouter } from "./project-router.js";
import { projectPathFromUrl } from "./project-router.js";
import type { GroupMessageSender } from "./pipeline-notification.js";
import type { PipelineEvent, RepairOutcome } from "../types.js";
import { logger } from "../util/log.js";
import { quoteSection, taskInfoSection } from "./task-info.js";

/** Decision info attached to a decidable escalation notification. */
export interface EscalationDecision {
	readonly decisionId: string;
	readonly expiresAt: string;
}

/** Escalated outcome slice the notifier consumes. */
export type EscalatedOutcome = Extract<RepairOutcome, { kind: "escalated" }>;

export interface EscalationNotifier {
	notifyEscalated(
		event: PipelineEvent,
		outcome: EscalatedOutcome,
		decision?: EscalationDecision,
	): Promise<void>;
	/** T09: terminal notification after a resumed escalation (one-round limit). */
	notifyResumeTerminal(
		event: PipelineEvent,
		outcome: EscalatedOutcome,
	): Promise<void>;
}

export interface EscalationNotifierDeps {
	readonly router: ProjectRouter;
	readonly sender: GroupMessageSender;
	/** webhook 即时播报原文（主进程内存）；终局通知引用块，缺省则不引用。 */
	readonly originalBroadcast?: (pipelineId: number) => string | undefined;
}

function shortSha(sha: string): string {
	return sha.slice(0, 8);
}

/** 结构化转交消息：任务 → 原始播报引用 → 结论 → 任务信息。 */
function buildHandoffMessage(
	event: PipelineEvent,
	outcome: EscalatedOutcome,
	originalBroadcast?: string,
): DingTalkMessage {
	return {
		title: "CI 自愈转交人工",
		text: [
			"### 🚨 CI 自愈转交人工",
			"",
			"**任务**",
			`- 项目：${event.projectId}`,
			`- 分支：${event.ref} @ ${shortSha(event.sha)}`,
			...(outcome.mrUrl ? [`- MR（部分修复）：${outcome.mrUrl}`] : []),
			"",
			...quoteSection(originalBroadcast),
			"**结论**",
			`- 转交原因：${outcome.summary}`,
			...(outcome.diagnosisSummary &&
			outcome.diagnosisSummary !== outcome.summary
				? [`- 诊断：${outcome.diagnosisSummary}`]
				: []),
			"",
			...taskInfoSection(outcome.agentStats),
		].join("\n"),
	};
}

/** 结构化待决策消息：任务 → 原始播报引用 → 结论 → 任务信息 → 决策命令。 */
function buildDecisionMessage(
	event: PipelineEvent,
	outcome: EscalatedOutcome,
	decision: EscalationDecision,
	originalBroadcast?: string,
): DingTalkMessage {
	return {
		title: "CI 自愈待人工决策",
		text: [
			"### ⏳ CI 自愈待人工决策",
			"",
			"**任务**",
			`- 项目：${event.projectId}`,
			`- 分支：${event.ref} @ ${shortSha(event.sha)}`,
			...(outcome.mrUrl ? [`- MR（部分修复）：${outcome.mrUrl}`] : []),
			"",
			...quoteSection(originalBroadcast),
			"**结论**",
			`- 诊断：${outcome.diagnosisSummary ?? outcome.summary}`,
			"",
			...taskInfoSection(outcome.agentStats),
			"",
			"**需要人工决策**",
			`- 决策 id：${decision.decisionId}`,
			"- 回复命令决策（复制即用）：",
			`- \`/heal ${decision.decisionId} test|prod|drop [备注]\``,
			`- 过期时间：${decision.expiresAt}`,
		].join("\n"),
	};
}

/** 结构化二次转交（终局）消息（T09）。 */
function buildResumeTerminalMessage(
	event: PipelineEvent,
	outcome: EscalatedOutcome,
): DingTalkMessage {
	return {
		title: "CI 自愈二次转交（终局）",
		text: [
			"### 🔴 CI 自愈二次转交（终局）",
			"",
			"**任务**",
			`- 项目：${event.projectId}`,
			`- 分支：${event.ref} @ ${shortSha(event.sha)}`,
			...(outcome.mrUrl ? [`- MR（部分修复）：${outcome.mrUrl}`] : []),
			"",
			"**结论**",
			`- 原因：${outcome.summary}`,
			"- 说明：人工介入后仍无法修复，请人工接手",
			"",
			...taskInfoSection(outcome.agentStats),
		].join("\n"),
	};
}

/**
 * Wire the routed escalation notifier. Unrouted projects are skipped with a
 * warning (same degradation as the webhook failure broadcast); transport
 * errors propagate to the caller (the scheduler logs and continues).
 */
export function createEscalationNotifier(
	deps: EscalationNotifierDeps,
): EscalationNotifier {
	return {
		async notifyEscalated(event, outcome, decision) {
			const conversationId = deps.router.resolve(projectPathFromUrl(event.projectUrl));
			if (!conversationId) {
				logger.warn(
					{ projectId: event.projectId, pipelineId: event.pipelineId },
					"escalation notification skipped: no group route",
				);
				return;
			}
			// Degraded path: decidable but no registered decision (registration
			// failed or store absent) → plain handoff message, never crash.
			const original = deps.originalBroadcast?.(event.pipelineId);
			const message =
				outcome.decidable && decision
					? buildDecisionMessage(event, outcome, decision, original)
					: buildHandoffMessage(event, outcome, original);
			await deps.sender.sendTo(conversationId, message);
		},
		async notifyResumeTerminal(event, outcome) {
			const conversationId = deps.router.resolve(projectPathFromUrl(event.projectUrl));
			if (!conversationId) {
				logger.warn(
					{ projectId: event.projectId, pipelineId: event.pipelineId },
					"resume terminal notification skipped: no group route",
				);
				return;
			}
			await deps.sender.sendTo(
				conversationId,
				buildResumeTerminalMessage(event, outcome),
			);
		},
	};
}
