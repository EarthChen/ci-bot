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

import { randomBytes, randomUUID } from "node:crypto";
import { join } from "node:path";
import { logger } from "../util/log.js";
import type { PipelineEvent, RepairOutcome } from "../types.js";
import type { CreateDecisionParams, DecisionRecord, DecisionStore } from "../decision/store.js";
import type {
	EscalationDecision,
	EscalationNotifier,
} from "../notify/escalation-notifier.js";

/** Default decision TTL: 24h (overridable via CIHEAL_DECISION_TTL_MS). */
const DEFAULT_DECISION_TTL_MS = 86_400_000;

/** A unit of work the scheduler can run (abstract; the bot provides the impl). */
export interface ScheduledWorker {
	run(event: PipelineEvent, cwd: string): Promise<RepairOutcome>;
	/** Resume a retained scene in place (T05 contract; the worker entry's
	 *  resume branch is T06). Optional so repair-only workers still conform;
	 *  enqueueResume rejects loud when it is missing. */
	runResume?(task: ResumeTask): Promise<RepairOutcome>;
}

/**
 * Resume task envelope handed to the worker via CIHEAL_WORKER_TASK (T05
 * contract, consumed by the worker entry's resume branch in T06). The
 * worker runs against the RETAINED scene (cwd), not a fresh work dir.
 */
export interface ResumeTask {
	readonly mode: "resume";
	readonly event: PipelineEvent;
	readonly cwd: string;
	readonly decision: {
		readonly decisionId: string;
		readonly value: "test" | "widen";
		readonly remark: string;
		/** G3 扩围（ADR-0009）：批准的 MR diff 外文件清单（仅 widen）。 */
		readonly oosPaths?: readonly string[];
	};
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
	/** Decision store (main process). When present, a decidable escalated
	 *  outcome registers an awaiting_decision record (scene retention, T03). */
	readonly decisionStore?: Pick<DecisionStore, "create">;
	/** Routed escalation notifier (main process, T04). When present, every
	 *  escalated outcome triggers a routed group notification. */
	readonly escalationNotifier?: EscalationNotifier;
	/** Stage-name exclusion list (from CIHEAL_SKIP_STAGES). When every failed
	 *  stage of an event is in this list, enqueue returns "skipped" and no
	 *  repair runs (deterministic failures like format checks stay out of the
	 *  agent). Degrades to repair when failedStages is unknown/empty. */
	readonly skipStages?: readonly string[];
}

export type EnqueueStatus = "queued" | "duplicate" | "skipped";

interface QueueItem {
	readonly event: PipelineEvent;
}

/** Fresh per-event work dir (the runtime owns the work-root layout). */
export function workerWorkDir(root: string, event: PipelineEvent): string {
	return join(root, `${event.projectId}-${event.pipelineId}-${randomUUID()}`);
}

/** Parse CIHEAL_SKIP_STAGES (comma-separated stage names) into an exclusion
 *  list. Undefined when unset/blank/separators-only — no exclusion applies. */
export function parseSkipStages(raw: string | undefined): string[] | undefined {
	if (!raw) return undefined;
	const stages = raw
		.split(",")
		.map((s) => s.trim())
		.filter((s) => s.length > 0);
	return stages.length > 0 ? stages : undefined;
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
	/** Per-key promise chains keeping same-project resumes FIFO (T05). */
	private readonly resumeChains = new Map<string, Promise<void>>();
	/** Resumes scheduled but not yet finished (extends idle(), T05). */
	private pendingResumes = 0;

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
		if (this.stageExcluded(event)) {
			logger.info(
				{ key, failedStages: event.failedStages },
				"scheduler stage-exclusion skip",
			);
			return "skipped";
		}
		this.inflight.add(key);
		this.queue.push({ event });
		void this.pump();
		return "queued";
	}

	/** True when every failed stage is in the exclusion list. Degrades to
	 *  false (repair as usual) when nothing is known about the failure stages
	 *  or no exclusion is configured. */
	private stageExcluded(event: PipelineEvent): boolean {
		const skip = this.deps.skipStages;
		if (!skip || skip.length === 0) return false;
		const failed = event.failedStages;
		if (!failed || failed.length === 0) return false;
		return failed.every((stage) => skip.includes(stage));
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
			if (outcome.kind === "escalated") {
				// Order (T04): register the decision FIRST so the routed notification
				// carries the real decision id; a registration failure degrades to the
				// plain message (decision undefined) instead of crashing the scheduler.
				const decision = outcome.decidable
					? this.registerDecision(event, cwd, outcome.oosPaths)
					: undefined;
				await this.sendEscalationNotification(event, outcome, decision);
			}
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

	/**
	 * Register a human decision for a decidable escalation (T03). Runs in the
	 * main process AFTER the worker retained its scene; the decision id and TTL
	 * are bot-owned. Fail-loud: a create failure is logged at error level — the
	 * scene stays on disk but the decision is lost and needs manual cleanup.
	 */
	private registerDecision(
		event: PipelineEvent,
		cwd: string,
		oosPaths?: readonly string[],
	): EscalationDecision | undefined {
		const store = this.deps.decisionStore;
		if (!store) return undefined;
		const suffix = randomBytes(2).toString("hex");
		const decisionId = `D-${event.pipelineId}-${suffix}`;
		const ttlMs =
			Number(process.env.CIHEAL_DECISION_TTL_MS) || DEFAULT_DECISION_TTL_MS;
		const params: CreateDecisionParams = {
			decision_id: decisionId,
			pipeline_id: String(event.pipelineId),
			project_id: event.projectId,
			event_json: JSON.stringify(event),
			cwd_path: cwd,
			// The exact session jsonl is discovered at resume time (T06).
			session_path: join(cwd, ".pi-agent"),
			branch: `ci-self-heal/${event.ref}-${event.sha.slice(0, 8)}`,
			expires_at: new Date(Date.now() + ttlMs).toISOString(),
			// G3 扩围（ADR-0009）：widenable 转交冻入清单，/heal widen 依赖它。
			...(oosPaths?.length ? { oos_paths: JSON.stringify(oosPaths) } : {}),
		};
		try {
			store.create(params);
			logger.info(
				{
					decisionId,
					projectId: event.projectId,
					pipelineId: event.pipelineId,
					cwd,
				},
				"decision registered (awaiting_decision)",
			);
			return { decisionId, expiresAt: params.expires_at };
		} catch (err) {
			logger.error(
				{ err, decisionId, event, cwd },
				"decision registration failed — scene retained but decision lost; manual cleanup required",
			);
			return undefined;
		}
	}

	/**
	 * Main-process routed escalation notification (T04). Fail-loud in log
	 * only — a notification failure must never crash the scheduler loop.
	 */
	private async sendEscalationNotification(
		event: PipelineEvent,
		outcome: Extract<RepairOutcome, { kind: "escalated" }>,
		decision: EscalationDecision | undefined,
	): Promise<void> {
		const notifier = this.deps.escalationNotifier;
		if (!notifier) return;
		try {
			await notifier.notifyEscalated(event, outcome, decision);
		} catch (err) {
			logger.error({ err, event }, "escalation notification failed");
		}
	}

	/**
	 * Schedule a resume run for a `test` decision (T05). The resume runs
	 * against the RETAINED cwd (no fresh work dir) and is serialized under
	 * the same per-key policy as repairs (a resume never races a new webhook
	 * repair for the same project), but BYPASSES pipeline-id dedup — the
	 * original pipeline already completed.
	 *
	 * Resolves once the resume is scheduled; rejects loud on misconfiguration
	 * (no decisionStore / no runResume support / corrupt event_json) so the
	 * /heal command can compensate (revert to awaiting_decision) and retry.
	 */
	async enqueueResume(record: DecisionRecord): Promise<void> {
		if (!this.deps.decisionStore) {
			throw new Error(
				"scheduler misconfiguration: decisionStore is required for resume",
			);
		}
		if (!this.deps.workerManager.runResume) {
			throw new Error(
				"scheduler misconfiguration: workerManager.runResume is required for resume",
			);
		}
		let event: PipelineEvent;
		try {
			event = JSON.parse(record.event_json) as PipelineEvent;
		} catch (err) {
			// Fail loud with context: a corrupt event_json propagates to the
			// /heal compensating path — never resume against a half-parsed event.
			throw new Error(
				`resume decision ${record.decision_id} has corrupt event_json: ${
					(err as Error).message
				}`,
			);
		}
		const task: ResumeTask = {
			mode: "resume",
			event,
			cwd: record.cwd_path,
		decision: {
			decisionId: record.decision_id,
			value: record.decision_value === "widen" ? "widen" : "test",
			remark: record.remark ?? "",
			...(parseOosPaths(record)?.length
				? { oosPaths: parseOosPaths(record) }
				: {}),
		},
		};
		const key = this.deps.policy.serialKey(event);
		// FIFO per key: chain onto the previous resume for the same project.
		const previous = this.resumeChains.get(key) ?? Promise.resolve();
		const link = previous
			.catch(() => {})
			.then(() => this.runResumeSerialized(task));
		const tracked = link.finally(() => {
			this.pendingResumes--;
		});
		this.resumeChains.set(key, tracked.catch(() => {}));
		this.pendingResumes++;
		void tracked.catch(() => {});
	}

	/**
	 * Run one resume task under the per-key serialization + global cap (same
	 * invariants as pump()). Worker failures are logged, never rethrown — a
	 * failed resume is terminal for that decision (one-round intervention).
	 */
	private async runResumeSerialized(task: ResumeTask): Promise<void> {
		const key = this.deps.policy.serialKey(task.event);
		// Check-then-set is atomic: single-threaded, no await in between.
		while (this.activeKeys.has(key) || this.running >= this.effectiveCap) {
			await new Promise((r) => setTimeout(r, 10));
		}
		this.activeKeys.add(key);
		this.running++;
		try {
			const outcome = await this.deps.workerManager.runResume!(task);
			logger.info(
				{
					decisionId: task.decision.decisionId,
					projectId: task.event.projectId,
					cwd: task.cwd,
				},
				"resume completed",
			);
			// T09: a second escalation after a human decision is TERMINAL —
			// one routed notification, never a new decision. mr/failed outcomes
			// are worker-notified already; the main process stays silent.
			if (outcome.kind === "escalated") {
				await this.sendResumeTerminalNotification(task.event, outcome);
			}
		} catch (err) {
			const error = err instanceof Error ? err.message : String(err);
			logger.error(
				{ error, decisionId: task.decision.decisionId, cwd: task.cwd },
				"resume worker failed",
			);
		} finally {
			this.running--;
			this.activeKeys.delete(key);
			void this.pump();
		}
	}

	/**
	 * Terminal routed notification for a resume that escalated again (T09).
	 * Fail-loud in log only — never crash the scheduler over a notification.
	 */
	private async sendResumeTerminalNotification(
		event: PipelineEvent,
		outcome: Extract<RepairOutcome, { kind: "escalated" }>,
	): Promise<void> {
		const notifier = this.deps.escalationNotifier;
		if (!notifier) return;
		try {
			await notifier.notifyResumeTerminal(event, outcome);
		} catch (err) {
			logger.error({ err, event }, "resume terminal notification failed");
		}
	}

	/** Test affordance: wait until the queue is drained. */
	async idle(): Promise<void> {
		while (
			this.running > 0 ||
			this.queue.length > 0 ||
			this.pendingResumes > 0
		) {
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

/** 解析决策上的 oos_paths（JSON 数组）；损坏 fail-loud（widen 完全依赖清单）。 */
function parseOosPaths(record: DecisionRecord): readonly string[] | undefined {
	if (!record.oos_paths) return undefined;
	try {
		const parsed = JSON.parse(record.oos_paths) as unknown;
		if (Array.isArray(parsed) && parsed.every((p) => typeof p === "string")) {
			return parsed as string[];
		}
		throw new Error("oos_paths is not a string array");
	} catch (err) {
		throw new Error(
			`resume decision ${record.decision_id} has corrupt oos_paths: ${
				(err as Error).message
			}`,
		);
	}
}
