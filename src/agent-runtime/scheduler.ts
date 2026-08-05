/**
 * Scheduler — runtime-owned scheduling capability (通用能力层).
 *
 * Enforces a per-key serial + cross-key parallel policy declared by each
 * vertical agent via its `SchedulingPolicy`:
 *   - items sharing a `serialKey` NEVER run concurrently (strictly serial)
 *   - up to `effective = min(policy.maxParallel, maxWorkers)` distinct keys
 *     may run in parallel; `maxWorkers` is the runtime's global safety ceiling
 *
 * Idempotency: a pipeline id already enqueued or in-flight is dropped.
 * Crash self-fault: after N consecutive worker crashes, the notifier alerts.
 *
 * This capability lives in the shared runtime and depends only on abstract
 * `ScheduledWorker` / `SchedulerNotifier` interfaces — the bot wires in its
 * concrete subprocess worker + DingTalk notifier (no runtime→bot dependency).
 */

import { randomUUID } from "node:crypto";
import { join } from "node:path";
import { logger } from "../util/log.js";
import type { PipelineEvent, RepairOutcome } from "../types.js";

/** A unit of work the scheduler can run (abstract; the bot provides the impl). */
export interface ScheduledWorker {
	run(event: PipelineEvent, cwd: string): Promise<RepairOutcome>;
}

export interface SchedulerNotifierMessage {
	readonly title: string;
	readonly text: string;
}

export interface SchedulerNotifier {
	send(message: SchedulerNotifierMessage): Promise<void>;
}

/** A vertical agent's scheduling declaration: partition + requested degree. */
export interface SchedulingPolicy {
	/** Partition key — items sharing a key are serialized (e.g. projectId). */
	serialKey: (event: PipelineEvent) => string;
	/** Requested parallelism degree; capped by the runtime's global maxWorkers. */
	maxParallel: number;
}

export interface SchedulerDeps {
	readonly workerManager: ScheduledWorker;
	readonly workRoot: string;
	readonly policy: SchedulingPolicy;
	/** Global safety ceiling on concurrent workers (across all keys). */
	readonly maxWorkers: number;
	readonly notifier?: SchedulerNotifier;
	readonly workerCrashThreshold?: number;
}

export type EnqueueStatus = "queued" | "duplicate";

interface QueueItem {
	readonly event: PipelineEvent;
}

/** Fresh per-event work dir (the runtime owns the work-root layout). */
export function workerWorkDir(root: string, event: PipelineEvent): string {
	return join(root, `${event.projectId}-${event.pipelineId}-${randomUUID()}`);
}

export class Scheduler {
	private readonly queue: QueueItem[] = [];
	private running = 0;
	/** pipeline ids currently enqueued or in-flight (idempotent dedup). */
	private readonly inflight = new Set<string>();
	/** serialKey values currently in-flight (enforces per-key serial). */
	private readonly activeKeys = new Set<string>();
	private crashCount = 0;
	private readonly effectiveCap: number;

	constructor(private readonly deps: SchedulerDeps) {
		this.effectiveCap = Math.max(
			1,
			Math.min(this.deps.policy.maxParallel, this.deps.maxWorkers),
		);
	}

	/**
	 * Enqueue an event (fire-and-forget). The webhook handler resolves 202
	 * immediately; the actual repair outcome surfaces via DingTalk / MR.
	 * Returns "duplicate" if the pipeline id is already enqueued/in-flight.
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

	/** Pump items while under the (effective) concurrency cap and not key-blocked. */
	private async pump(): Promise<void> {
		while (this.running < this.effectiveCap && this.queue.length > 0) {
			const idx = this.queue.findIndex(
				(item) => !this.activeKeys.has(this.deps.policy.serialKey(item.event)),
			);
			if (idx < 0) break; // every queued item is blocked by an active same-key run
			const [item] = this.queue.splice(idx, 1);
			const key = this.deps.policy.serialKey(item.event);
			this.activeKeys.add(key);
			this.running++;
			// Detach: pump() must not await per-item work, or concurrency caps.
			void this.runOne(item)
				.catch(() => {})
				.finally(() => {
					this.running--;
					this.activeKeys.delete(key);
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
