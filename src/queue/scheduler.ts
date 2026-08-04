/**
 * Scheduler — global FIFO queue with concurrency cap + per-project serial
 * ordering (G4).
 *
 * Ticket 01: concurrency = 1 (effective serial). Ticket 05 lifts above 1
 * and adds cross-pipeline expiry.
 *
 * Idempotency: a pipeline id already enqueued or in-flight is dropped (GitLab
 * webhook retries must not trigger duplicate work).
 */

import { logger } from "../util/log.js";
import type { PipelineEvent } from "../types.js";
import type { WorkerManager } from "../worker/manager.js";
import { workerWorkDir } from "../worker/manager.js";
import type { DingTalkNotifier } from "../notify/dingtalk.js";

export interface SchedulerDeps {
	readonly workerManager: WorkerManager;
	/** Per-worker working-dir root. Each event gets a fresh subdir. */
	readonly workRoot: string;
	/** Global concurrency cap. v1 = 1. */
	readonly concurrency: number;
	/** Ticket 07: notifier for worker-crash self-fault alerts. Optional. */
	readonly notifier?: DingTalkNotifier;
	/** Ticket 07: consecutive worker crashes before a self-fault alert. */
	readonly workerCrashThreshold?: number;
}

export type EnqueueStatus = "queued" | "duplicate";

interface QueueItem {
	readonly event: PipelineEvent;
}

export class Scheduler {
	private readonly queue: QueueItem[] = [];
	private running = 0;
	/** Pipeline ids currently enqueued or in-flight (idempotent dedup). */
	private readonly inflight = new Set<string>();
	/** Ticket 07: consecutive worker-crash counter (reset on success). */
	private crashCount = 0;

	constructor(private readonly deps: SchedulerDeps) {}

	/**
	 * Enqueue an event (fire-and-forget). The webhook handler resolves 202
	 * immediately; the actual repair outcome surfaces via DingTalk / MR.
	 *
	 * Returns "duplicate" if the pipeline id is already enqueued/in-flight
	 * (GitLab webhook retries are deduped), otherwise "queued".
	 */
	enqueue(event: PipelineEvent): EnqueueStatus {
		const key = dedupKey(event);
		if (this.inflight.has(key)) {
			logger.info({ key }, "scheduler dedup drop");
			return "duplicate";
		}
		this.inflight.add(key);
		this.queue.push({ event });
		void this.pump();
		return "queued";
	}

	/** Pump items while under the concurrency cap. */
	private async pump(): Promise<void> {
		while (this.running < this.deps.concurrency && this.queue.length > 0) {
			const item = this.queue.shift();
			if (!item) break;
			this.running++;
			// Detach: pump() must not await per-item work, or concurrency caps.
			void this.runOne(item)
				.catch(() => {})
				.finally(() => {
					this.running--;
					void this.pump();
				});
		}
	}

	private async runOne(item: QueueItem): Promise<void> {
		const { event } = item;
		const cwd = workerWorkDir(this.deps.workRoot, event);
		try {
			const outcome = await this.deps.workerManager.run(event, cwd);
			this.crashCount = 0; // reset on success — transient crashes don't accumulate.
			logger.info({ event, outcome: outcome.kind }, "repair completed");
		} catch (err) {
			const error = err instanceof Error ? err.message : String(err);
			logger.error({ event, error }, "worker crashed");
			// Ticket 07: self-fault alert after N consecutive worker crashes.
			this.crashCount++;
			const threshold = this.deps.workerCrashThreshold ?? 3;
			if (this.deps.notifier && this.crashCount >= threshold) {
				void this.deps.notifier
					.send({
						title: "CI 自愈 Bot 自故障",
						text: [
							`连续 ${this.crashCount} 次 worker 崩溃，bot 可能无法修复。`,
							`最近一次：项目 ${event.projectId} pipeline ${event.pipelineId}：worker 异常，详情见服务日志`,
							`请人工检查 worker 运行环境（Node/tsx/依赖/磁盘）。`,
						].join("\n"),
					})
					.catch((notifyErr) =>
						logger.warn({ notifyErr }, "crash alert failed"),
					);
				// Reset after alerting to avoid flooding one alert per crash.
				this.crashCount = 0;
			}
		} finally {
			this.inflight.delete(dedupKey(event));
		}
	}

	/** Test affordance: wait until the queue is drained. */
	async idle(): Promise<void> {
		while (this.running > 0 || this.queue.length > 0) {
			await new Promise((r) => setTimeout(r, 10));
		}
	}

	/** Snapshot for tests/debug. */
	stats(): { running: number; queued: number; inflight: number } {
		return {
			running: this.running,
			queued: this.queue.length,
			inflight: this.inflight.size,
		};
	}
}

function dedupKey(event: PipelineEvent): string {
	return `${event.projectId}:${event.pipelineId}`;
}
