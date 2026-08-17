import { describe, it, expect, vi } from "vitest";
import {
	Scheduler,
	type ScheduledWorker,
	type SchedulingPolicy,
} from "../../src/agent-runtime/scheduler.js";
import { CI_REPAIR_SCHEDULING_POLICY } from "../../src/agent/ci-repair-definition.js";
import { join } from "node:path";
import type { PipelineEvent, RepairOutcome } from "../../src/types.js";

function makeEvent(projectId: string, pipelineId: number): PipelineEvent {
	return {
		projectId,
		pipelineId,
		ref: "main",
		sha: "abc1234567890",
		projectUrl: "https://git.example.com/g/p",
	};
}

function delay(ms: number): Promise<void> {
	return new Promise((r) => setTimeout(r, ms));
}

/**
 * Fake worker: records a per-run timeline + live concurrency so the test can
 * assert the per-key serial / cross-key parallel invariants WITHOUT real
 * subprocesses or wall-clock flakiness (we count concurrent runs, not times).
 */
function fakeWorker() {
	const runs: Array<{ key: string }> = [];
	const perKeyLive = new Map<string, number>();
	let maxLive = 0;
	let maxPerKeyLive = 0;
	const workerManager: ScheduledWorker = {
		async run(event) {
			const key = event.projectId;
			perKeyLive.set(key, (perKeyLive.get(key) ?? 0) + 1);
			maxPerKeyLive = Math.max(maxPerKeyLive, perKeyLive.get(key) ?? 0);
			const live = [...perKeyLive.values()].reduce((a, b) => a + b, 0);
			maxLive = Math.max(maxLive, live);
			await delay(20);
			perKeyLive.set(key, (perKeyLive.get(key) ?? 0) - 1);
			runs.push({ key });
			return { kind: "escalated", summary: "x" };
		},
	};
	return {
		workerManager,
		runs: () => runs,
		maxLive: () => maxLive,
		maxPerKeyLive: () => maxPerKeyLive,
	};
}

describe("Scheduler — per-key serial + cross-key parallel（候选 E）", () => {
	it("同 project 严格串行，不同 project 可并行（effective 上限）", async () => {
		const { workerManager, runs, maxLive, maxPerKeyLive } = fakeWorker();
		const scheduler = new Scheduler({
			workerManager,
			workRoot: "/tmp/w",
			policy: CI_REPAIR_SCHEDULING_POLICY,
			maxWorkers: 2,
		});
		scheduler.enqueue(makeEvent("A", 1));
		scheduler.enqueue(makeEvent("A", 2));
		scheduler.enqueue(makeEvent("B", 1));
		scheduler.enqueue(makeEvent("B", 2));
		await scheduler.idle();

		// 同 key 峰值并发 = 1 → 串行不变量
		expect(maxPerKeyLive()).toBe(1);
		// 跨 key 出现过并发 → 并行确实发生
		expect(maxLive()).toBeGreaterThan(1);
		// 全部 4 个都跑完
		expect(runs().length).toBe(4);
	});

	it("effective = min(policy.maxParallel, maxWorkers) 为硬上限", async () => {
		const { workerManager, maxLive } = fakeWorker();
		const policy: SchedulingPolicy = { serialKey: (e) => e.projectId, maxParallel: 8 };
		const scheduler = new Scheduler({
			workerManager,
			workRoot: "/tmp/w",
			policy,
			maxWorkers: 2,
		});
		for (let i = 0; i < 4; i++) scheduler.enqueue(makeEvent(`P${i}`, i));
		await scheduler.idle();
		expect(maxLive()).toBeLessThanOrEqual(2);
	});

	it("同 pipelineId 重入 → duplicate（幂等去重）", async () => {
		const { workerManager, runs } = fakeWorker();
		const scheduler = new Scheduler({
			workerManager,
			workRoot: "/tmp/w",
			policy: CI_REPAIR_SCHEDULING_POLICY,
			maxWorkers: 2,
		});
		expect(scheduler.enqueue(makeEvent("A", 1))).toBe("queued");
		expect(scheduler.enqueue(makeEvent("A", 1))).toBe("duplicate");
		await scheduler.idle();
		expect(runs().filter((r) => r.key === "A").length).toBe(1);
	});

	it("连续 worker 崩溃 ≥ 阈值 → notifier 被调用（自警）", async () => {
		const failingWorker: ScheduledWorker = {
			async run() {
				throw new Error("boom");
			},
		};
		const send = vi.fn(async () => {});
		const scheduler = new Scheduler({
			workerManager: failingWorker,
			workRoot: "/tmp/w",
			policy: CI_REPAIR_SCHEDULING_POLICY,
			maxWorkers: 1,
			notifier: { send },
			workerCrashThreshold: 2,
		});
		scheduler.enqueue(makeEvent("A", 1));
		scheduler.enqueue(makeEvent("A", 2));
		await scheduler.idle();
		expect(send).toHaveBeenCalled();
	});
});

describe("Scheduler — 决策注册（decidable escalated）", () => {
	function decisionWorker(outcome: RepairOutcome): ScheduledWorker {
		return { run: async () => outcome };
	}

	it("decidable escalated → 注册决策到 decisionStore", async () => {
		const create = vi.fn();
		const scheduler = new Scheduler({
			workerManager: decisionWorker({
				kind: "escalated",
				summary: "need human decision",
				decidable: true,
				diagnosisSummary: "spec unreadable",
			}),
			workRoot: "/tmp/w",
			policy: CI_REPAIR_SCHEDULING_POLICY,
			maxWorkers: 1,
			decisionStore: { create },
		});
		scheduler.enqueue(makeEvent("proj-A", 777));
		await scheduler.idle();

		expect(create).toHaveBeenCalledTimes(1);
		const params = create.mock.calls[0][0];
		expect(params.decision_id).toMatch(/^D-777-[0-9a-f]{4}$/);
		expect(params.project_id).toBe("proj-A");
		expect(params.pipeline_id).toBe("777");
		expect(params.branch).toBe("ci-self-heal/main-abc12345");
		expect(params.cwd_path.startsWith("/tmp/w")).toBe(true);
		expect(params.session_path).toBe(join(params.cwd_path, ".pi-agent"));
		expect(params.event_json).toContain("proj-A");
		expect(new Date(params.expires_at).getTime()).toBeGreaterThan(Date.now());
	});

	it("非 decidable escalated 与 mr → 不注册决策", async () => {
		const create = vi.fn();
		const scheduler = new Scheduler({
			workerManager: decisionWorker({ kind: "escalated", summary: "x" }),
			workRoot: "/tmp/w",
			policy: CI_REPAIR_SCHEDULING_POLICY,
			maxWorkers: 2,
			decisionStore: { create },
		});
		scheduler.enqueue(makeEvent("A", 1));
		await scheduler.idle();
		expect(create).not.toHaveBeenCalled();

		const mrScheduler = new Scheduler({
			workerManager: decisionWorker({
				kind: "mr",
				mrUrl: "https://mr/1",
				summary: "fixed",
			}),
			workRoot: "/tmp/w",
			policy: CI_REPAIR_SCHEDULING_POLICY,
			maxWorkers: 2,
			decisionStore: { create },
		});
		mrScheduler.enqueue(makeEvent("A", 2));
		await mrScheduler.idle();
		expect(create).not.toHaveBeenCalled();
	});

	it("CIHEAL_DECISION_TTL_MS 控制 expires_at", async () => {
		const orig = process.env.CIHEAL_DECISION_TTL_MS;
		process.env.CIHEAL_DECISION_TTL_MS = "3600000";
		const create = vi.fn();
		const scheduler = new Scheduler({
			workerManager: decisionWorker({
				kind: "escalated",
				summary: "x",
				decidable: true,
			}),
			workRoot: "/tmp/w",
			policy: CI_REPAIR_SCHEDULING_POLICY,
			maxWorkers: 1,
			decisionStore: { create },
		});
		scheduler.enqueue(makeEvent("A", 3));
		await scheduler.idle();
		const params = create.mock.calls[0][0];
		const delta = new Date(params.expires_at).getTime() - Date.now();
		expect(delta).toBeGreaterThan(3_500_000);
		expect(delta).toBeLessThanOrEqual(3_600_000);
		if (orig === undefined) delete process.env.CIHEAL_DECISION_TTL_MS; else process.env.CIHEAL_DECISION_TTL_MS = orig;
	});

	it("decisionStore.create 抛错 → 不崩调度（fail loud 走日志）", async () => {
		const create = vi.fn(() => {
			throw new Error("db down");
		});
		const scheduler = new Scheduler({
			workerManager: decisionWorker({
				kind: "escalated",
				summary: "x",
				decidable: true,
			}),
			workRoot: "/tmp/w",
			policy: CI_REPAIR_SCHEDULING_POLICY,
			maxWorkers: 1,
			decisionStore: { create },
		});
		scheduler.enqueue(makeEvent("A", 4));
		await scheduler.idle();
		expect(create).toHaveBeenCalledTimes(1);
		// 调度正常收尾（无 crash 计数、无挂起）
		expect(scheduler.stats()).toEqual({ running: 0, queued: 0, inflight: 0 });
	});
});

describe("Scheduler — routed escalation 通知（T04）", () => {
	function notifySpy() {
		return { notifyEscalated: vi.fn(async () => {}) };
	}

	it("decidable escalated → 先注册决策，再带 decision 通知", async () => {
		const create = vi.fn();
		const escalationNotifier = notifySpy();
		const scheduler = new Scheduler({
			workerManager: {
				run: async () => ({
					kind: "escalated" as const,
					summary: "need human decision",
					decidable: true,
					diagnosisSummary: "spec unreadable",
				}),
			},
			workRoot: "/tmp/w",
			policy: CI_REPAIR_SCHEDULING_POLICY,
			maxWorkers: 1,
			decisionStore: { create },
			escalationNotifier,
		});
		scheduler.enqueue(makeEvent("proj-A", 777));
		await scheduler.idle();

		expect(create).toHaveBeenCalledTimes(1);
		expect(escalationNotifier.notifyEscalated).toHaveBeenCalledTimes(1);
		const [event, outcome, decision] =
			escalationNotifier.notifyEscalated.mock.calls[0];
		expect(event.pipelineId).toBe(777);
		expect(outcome.kind).toBe("escalated");
		// decision 来自 registerDecision（顺序：先注册后通知，消息带真实 id）
		const params = create.mock.calls[0][0];
		expect(decision).toEqual({
			decisionId: params.decision_id,
			expiresAt: params.expires_at,
		});
	});

	it("决策注册失败 → 降级：通知仍发出，decision 为 undefined", async () => {
		const create = vi.fn(() => {
			throw new Error("db down");
		});
		const escalationNotifier = notifySpy();
		const scheduler = new Scheduler({
			workerManager: {
				run: async () => ({
					kind: "escalated" as const,
					summary: "need human decision",
					decidable: true,
				}),
			},
			workRoot: "/tmp/w",
			policy: CI_REPAIR_SCHEDULING_POLICY,
			maxWorkers: 1,
			decisionStore: { create },
			escalationNotifier,
		});
		scheduler.enqueue(makeEvent("A", 5));
		await scheduler.idle();

		expect(escalationNotifier.notifyEscalated).toHaveBeenCalledTimes(1);
		expect(escalationNotifier.notifyEscalated.mock.calls[0][2]).toBeUndefined();
		expect(scheduler.stats()).toEqual({ running: 0, queued: 0, inflight: 0 });
	});

	it("非 decidable escalated → 通知发出但无 decision，不注册", async () => {
		const create = vi.fn();
		const escalationNotifier = notifySpy();
		const scheduler = new Scheduler({
			workerManager: {
				run: async () => ({ kind: "escalated" as const, summary: "budget" }),
			},
			workRoot: "/tmp/w",
			policy: CI_REPAIR_SCHEDULING_POLICY,
			maxWorkers: 1,
			decisionStore: { create },
			escalationNotifier,
		});
		scheduler.enqueue(makeEvent("A", 6));
		await scheduler.idle();

		expect(create).not.toHaveBeenCalled();
		expect(escalationNotifier.notifyEscalated).toHaveBeenCalledTimes(1);
		expect(escalationNotifier.notifyEscalated.mock.calls[0][2]).toBeUndefined();
	});

	it("mr / failed outcome → 不触发 escalation 通知", async () => {
		const escalationNotifier = notifySpy();
		const scheduler = new Scheduler({
			workerManager: {
				run: async () => ({
					kind: "mr" as const,
					mrUrl: "https://mr/1",
					summary: "fixed",
				}),
			},
			workRoot: "/tmp/w",
			policy: CI_REPAIR_SCHEDULING_POLICY,
			maxWorkers: 1,
			escalationNotifier,
		});
		scheduler.enqueue(makeEvent("A", 7));
		await scheduler.idle();
		expect(escalationNotifier.notifyEscalated).not.toHaveBeenCalled();
	});

	it("notifyEscalated 抛错 → 不崩调度（fail loud 走日志）", async () => {
		const escalationNotifier = {
			notifyEscalated: vi.fn(async () => {
				throw new Error("dingtalk down");
			}),
		};
		const scheduler = new Scheduler({
			workerManager: {
				run: async () => ({ kind: "escalated" as const, summary: "x" }),
			},
			workRoot: "/tmp/w",
			policy: CI_REPAIR_SCHEDULING_POLICY,
			maxWorkers: 1,
			escalationNotifier,
		});
		scheduler.enqueue(makeEvent("A", 8));
		await scheduler.idle();
		expect(escalationNotifier.notifyEscalated).toHaveBeenCalledTimes(1);
		expect(scheduler.stats()).toEqual({ running: 0, queued: 0, inflight: 0 });
	});
});
