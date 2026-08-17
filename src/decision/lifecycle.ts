/**
 * Decision lifecycle hooks (T07).
 *
 * onNewPipeline: when a NEW pipeline event for a project is accepted by the
 * webhook, every awaiting decision of that project is invalidated — humans
 * must never decide on a stale sha. The store transitions the rows in one
 * transaction, each retained scene is cleaned (best-effort), and ONE routed
 * group notification summarizes what was invalidated. T08 will extend this
 * module with the TTL sweep.
 */

import type { DingTalkMessage } from "../notify/dingtalk.js";
import type { GroupMessageSender } from "../notify/pipeline-notification.js";
import type { ProjectRouter } from "../notify/project-router.js";
import type { PipelineEvent } from "../types.js";
import { logger } from "../util/log.js";
import { cleanupScene } from "../worker/manager.js";
import type { DecisionRecord, DecisionStore } from "./store.js";

export interface DecisionLifecycleDeps {
	readonly store: DecisionStore;
	readonly router: ProjectRouter;
	readonly sender: GroupMessageSender;
}

export interface DecisionLifecycle {
	/** Called when a NEW pipeline event is accepted (enqueued) by the webhook. */
	onNewPipeline(event: PipelineEvent): Promise<void>;
}

export function createDecisionLifecycle(
	deps: DecisionLifecycleDeps,
): DecisionLifecycle {
	return {
		async onNewPipeline(event) {
			const invalidated = deps.store.invalidateByProject(event.projectId);
			if (invalidated.length === 0) return;

			for (const record of invalidated) {
				await cleanupRecordScene(record);
			}

			const conversationId = deps.router.resolve(event.projectId);
			if (!conversationId) {
				logger.warn(
					{ projectId: event.projectId, pipelineId: event.pipelineId },
					"invalidation notification skipped: no group route",
				);
				return;
			}
			await deps.sender.sendTo(
				conversationId,
				buildInvalidationMessage(event, invalidated),
			);
		},
	};
}

/** Best-effort scene cleanup for one invalidated decision — never throws. */
async function cleanupRecordScene(record: DecisionRecord): Promise<void> {
	try {
		const event = JSON.parse(record.event_json) as PipelineEvent;
		await cleanupScene(event, record.cwd_path);
	} catch (err) {
		logger.warn(
			{ err, decisionId: record.decision_id },
			"invalidated decision scene cleanup failed",
		);
	}
}

/** One group message summarizing every invalidated decision id. */
function buildInvalidationMessage(
	event: PipelineEvent,
	invalidated: readonly DecisionRecord[],
): DingTalkMessage {
	return {
		title: "CI 自愈决策已作废",
		text: [
			`项目 ${event.projectId}`,
			`新 pipeline #${event.pipelineId} 到达，${invalidated.length} 个待决策已作废：`,
			...invalidated.map((r) => `- ${r.decision_id}`),
		].join("\n"),
	};
}
