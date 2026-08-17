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
import type { GroupMessageSender } from "./pipeline-notification.js";
import type { PipelineEvent, RepairOutcome } from "../types.js";
import { logger } from "../util/log.js";

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
}

export interface EscalationNotifierDeps {
	readonly router: ProjectRouter;
	readonly sender: GroupMessageSender;
}

function shortSha(sha: string): string {
	return sha.slice(0, 8);
}

/** Plain handoff message — content identical to the old worker notification. */
function buildHandoffMessage(
	event: PipelineEvent,
	reason: string,
): DingTalkMessage {
	return {
		title: "CI 自愈转交人工",
		text: [
			`项目 ${event.projectId}`,
			`分支 ${event.ref} @ ${shortSha(event.sha)}`,
			`原因：${reason}`,
		].join("\n"),
	};
}

/** Decidable message: diagnosis + decision id + /heal template + expiry. */
function buildDecisionMessage(
	event: PipelineEvent,
	outcome: EscalatedOutcome,
	decision: EscalationDecision,
): DingTalkMessage {
	return {
		title: "CI 自愈待人工决策",
		text: [
			`项目 ${event.projectId}`,
			`分支 ${event.ref} @ ${shortSha(event.sha)}`,
			`诊断：${outcome.diagnosisSummary ?? outcome.summary}`,
			`决策 id：${decision.decisionId}`,
			`回复命令决策（复制即用）：`,
			`/heal ${decision.decisionId} test|prod|drop [备注]`,
			`过期时间：${decision.expiresAt}`,
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
			const conversationId = deps.router.resolve(event.projectId);
			if (!conversationId) {
				logger.warn(
					{ projectId: event.projectId, pipelineId: event.pipelineId },
					"escalation notification skipped: no group route",
				);
				return;
			}
			// Degraded path: decidable but no registered decision (registration
			// failed or store absent) → plain handoff message, never crash.
			const message =
				outcome.decidable && decision
					? buildDecisionMessage(event, outcome, decision)
					: buildHandoffMessage(event, outcome.summary);
			await deps.sender.sendTo(conversationId, message);
		},
	};
}
