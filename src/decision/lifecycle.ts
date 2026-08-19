/**
 * Decision lifecycle hooks.
 *
 * onNewPipeline (T07): when a NEW pipeline event for a project is accepted
 * by the webhook, every awaiting decision of that project is invalidated —
 * humans must never decide on a stale sha. The store transitions the rows in
 * one transaction, each retained scene is cleaned (best-effort), and ONE
 * routed group notification summarizes what was invalidated.
 *
 * startTtlSweep (T08): main-process timer that sweeps expired decisions —
 * delete + scene cleanup + ONE routed notification per project per tick.
 */

import type { DingTalkMessage } from "../notify/dingtalk.js";
import type { GroupMessageSender } from "../notify/pipeline-notification.js";
import type { ProjectRouter } from "../notify/project-router.js";
import type { MrTerminalEvent, PipelineEvent } from "../types.js";
import { logger } from "../util/log.js";
import { cleanupScene } from "../worker/manager.js";
import type { DecisionRecord, DecisionStore } from "./store.js";

export interface DecisionLifecycleDeps {
	readonly store: DecisionStore;
	readonly router: ProjectRouter;
	readonly sender: GroupMessageSender;
}

/** Stop handle for the TTL sweep timer. */
export interface TtlSweepHandle {
	stop(): void;
}

export interface DecisionLifecycle {
	/** Called when a NEW pipeline event is accepted (enqueued) by the webhook. */
	onNewPipeline(event: PipelineEvent): Promise<void>;
	/** Called on MR terminal (merge/close): invalidate awaiting decisions
	 *  tied to that MR + clean their scenes. Silent — no group notification. */
	onMrTerminal(event: MrTerminalEvent): Promise<void>;
	/** Start the main-process TTL sweep timer (T08). Default interval 60s,
	 *  overridable via opts or CIHEAL_DECISION_SWEEP_INTERVAL_MS. */
	startTtlSweep(opts?: { intervalMs?: number }): TtlSweepHandle;
}

const DEFAULT_SWEEP_INTERVAL_MS = 60_000;

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
		async onMrTerminal(event) {
			// 该 MR 关联的待决策（event_json.mrIid 匹配）：MR 已合并/关闭，
			// 决策对象消失 → 作废 + 清现场。静默（仅日志）——MR 终局是正常
			// 生命周期，不打扰群。
			const matched = deps.store
				.listByProject(event.projectId)
				.filter(
					(r) =>
						r.status === "awaiting_decision" &&
						mrIidOf(r) === event.mrIid,
				);
			for (const record of matched) {
				deps.store.updateStatus(record.decision_id, {
					status: "invalidated",
					decided_by: "system:mr-terminal",
					remark: `MR ${event.mrIid} ${event.action}`,
				});
				await cleanupRecordScene(record);
			}
			if (matched.length > 0) {
				logger.info(
					{
						projectId: event.projectId,
						mrIid: event.mrIid,
						action: event.action,
						decisionIds: matched.map((r) => r.decision_id),
					},
					"awaiting decisions invalidated on MR terminal",
				);
			}
		},
		startTtlSweep(opts) {
			const intervalMs =
				opts?.intervalMs ??
				(Number(process.env.CIHEAL_DECISION_SWEEP_INTERVAL_MS) ||
					DEFAULT_SWEEP_INTERVAL_MS);
			const timer = setInterval(() => {
				void sweepOnce(deps).catch((err) => {
					logger.error({ err }, "decision TTL sweep failed; retrying next tick");
				});
			}, intervalMs);
			// The sweep must never keep the bot process alive on shutdown.
			timer.unref();
			return {
				stop() {
					clearInterval(timer);
				},
			};
		},
	};
}

/** Best-effort scene cleanup for one terminal decision — never throws. */
async function cleanupRecordScene(record: DecisionRecord): Promise<void> {
	try {
		const event = JSON.parse(record.event_json) as PipelineEvent;
		await cleanupScene(event, record.cwd_path);
	} catch (err) {
		logger.warn(
			{ err, decisionId: record.decision_id },
			"decision scene cleanup failed",
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

/** One sweep tick (T08): delete expired rows, clean scenes, notify per project. */
async function sweepOnce(deps: DecisionLifecycleDeps): Promise<void> {
	const expired = deps.store.sweepExpired();
	if (expired.length === 0) return;

	for (const record of expired) {
		await cleanupRecordScene(record);
	}

	// ONE message per project summarizing that project's expired decisions.
	const byProject = new Map<string, DecisionRecord[]>();
	for (const record of expired) {
		const group = byProject.get(record.project_id) ?? [];
		group.push(record);
		byProject.set(record.project_id, group);
	}

	for (const [projectId, records] of byProject) {
		const conversationId = deps.router.resolve(projectId);
		if (!conversationId) {
			logger.warn(
				{ projectId, decisionIds: records.map((r) => r.decision_id) },
				"expiry notification skipped: no group route",
			);
			continue;
		}
		try {
			await deps.sender.sendTo(
				conversationId,
				buildExpiryMessage(projectId, records),
			);
		} catch (err) {
			// One dead transport must not eat the other projects' notifications.
			logger.warn({ err, projectId }, "expiry notification failed");
		}
	}
}

/** One group message per project listing its expired decision ids. */
function buildExpiryMessage(
	projectId: string,
	expired: readonly DecisionRecord[],
): DingTalkMessage {
	return {
		title: "CI 自愈决策超时关闭",
		text: [
			`项目 ${projectId}`,
			`${expired.length} 个决策已超时关闭：`,
			...expired.map((r) => `- ${r.decision_id}`),
		].join("\n"),
	};
}

/** mrIid recorded on the decision (event_json); missing/unparseable → undefined. */
function mrIidOf(record: DecisionRecord): number | undefined {
	try {
		const event = JSON.parse(record.event_json) as PipelineEvent;
		return event.mrIid;
	} catch {
		return undefined;
	}
}
