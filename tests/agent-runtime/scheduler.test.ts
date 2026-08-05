import { describe, it, expect, vi } from "vitest";
import {
	Scheduler,
	type ScheduledWorker,
	type SchedulingPolicy,
} from "../../src/agent-runtime/scheduler.js";
import { CI_REPAIR_SCHEDULING_POLICY } from "../../src/agent/ci-repair-definition.js";
import type { PipelineEvent } from "../../src/types.js";

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
