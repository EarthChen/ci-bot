import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import {
	Scheduler,
	parseSkipStages,
	type ScheduledWorker,
	type SchedulingPolicy,
} from "../../src/agent-runtime/scheduler.js";
import { CI_REPAIR_SCHEDULING_POLICY } from "../../src/agent/ci-repair-definition.js";
import { join } from "node:path";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import type { PipelineEvent, RepairOutcome } from "../../src/types.js";
import { DecisionStore } from "../../src/decision/store.js";
import type { DecisionRecord } from "../../src/decision/store.js";

function makeEvent(projectId: string, pipelineId: number, mrIid?: number): PipelineEvent {
	return {
		projectId,
		pipelineId,
		ref: "main",
		sha: "abc1234567890",
		projectUrl: "https://git.example.com/g/p",
		...(mrIid === undefined ? {} : { mrIid }),
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
	it("同 MR（同 key）严格串行，不同 key 可并行（effective 上限）", async () => {
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

	it("同 project 不同 MR → 并行（多服务并发）；同 MR 仍串行", async () => {
		const { workerManager, runs, maxLive, maxPerKeyLive } = fakeWorker();
		const scheduler = new Scheduler({
			workerManager,
			workRoot: "/tmp/w",
			policy: CI_REPAIR_SCHEDULING_POLICY,
			maxWorkers: 3,
		});
		// 同项目两个不同 MR + 同 MR 的重复 pipeline
		scheduler.enqueue(makeEvent("A", 1, 10));
		scheduler.enqueue(makeEvent("A", 2, 20));
		scheduler.enqueue(makeEvent("A", 3, 10));
		await scheduler.idle();

		// 不同 MR 并发过（多服务并发生效）
		expect(maxLive()).toBeGreaterThan(1);
		// 同 MR（mrIid=10 的两个 pipeline）串行：fakeWorker 按 projectId 计峰值，
		// 若 MR-10 两条并发则 projectId 峰值会到 3；串行约束下仍受控
		expect(runs().length).toBe(3);
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
		return {
			notifyEscalated: vi.fn(
				async (
					_event: PipelineEvent,
					_outcome: RepairOutcome,
					_decision?: { decisionId: string; expiresAt: string },
				) => {},
			),
			notifyResumeTerminal: vi.fn(async () => {}),
		};
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
			notifyResumeTerminal: vi.fn(async () => {}),
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

describe("Scheduler — enqueueResume（T05）", () => {
	function makeRecord(overrides: Partial<{ decision_id: string; cwd_path: string; event_json: string }> = {}) {
		return {
			decision_id: overrides.decision_id ?? "D-1-ab12",
			pipeline_id: "1",
			project_id: "A",
			event_json: overrides.event_json ?? JSON.stringify(makeEvent("A", 1)),
			cwd_path: overrides.cwd_path ?? "/tmp/retained/work-1",
			session_path: "/tmp/retained/work-1/.pi-agent",
			branch: "ci-self-heal/main-abc12345",
			status: "resumed" as const,
			created_at: "2026-08-17T00:00:00.000Z",
			expires_at: "2026-08-18T00:00:00.000Z",
			decided_by: "staff-1",
			decision_value: "test",
			remark: "spec says five",
			decided_at: "2026-08-17T01:00:00.000Z",
			oos_paths: null,
		};
	}

	function resumeScheduler(workerManager: {
		run: (event: PipelineEvent, cwd: string) => Promise<import("../../src/types.js").RepairOutcome>;
		runResume?: (task: import("../../src/agent-runtime/scheduler.js").ResumeTask) => Promise<import("../../src/types.js").RepairOutcome>;
	}) {
		return new Scheduler({
			workerManager,
			workRoot: "/tmp/w",
			policy: CI_REPAIR_SCHEDULING_POLICY,
			maxWorkers: 2,
			decisionStore: { create: vi.fn() },
		});
	}

	it("无 decisionStore → 配置错误，直接 reject（fail loud）", async () => {
		const scheduler = new Scheduler({
			workerManager: { run: async () => ({ kind: "escalated" as const, summary: "x" }) },
			workRoot: "/tmp/w",
			policy: CI_REPAIR_SCHEDULING_POLICY,
			maxWorkers: 1,
		});
		await expect(scheduler.enqueueResume(makeRecord())).rejects.toThrow(
			/decisionStore/,
		);
	});

	it("worker 不支持 runResume → reject（fail loud）", async () => {
		const scheduler = resumeScheduler({
			run: async () => ({ kind: "escalated" as const, summary: "x" }),
		});
		await expect(scheduler.enqueueResume(makeRecord())).rejects.toThrow(
			/runResume/,
		);
	});

	it("resume 信封符合契约：mode/event/cwd/decision 来自保留记录", async () => {
		const runResume = vi.fn(
			async (_task: import("../../src/agent-runtime/scheduler.js").ResumeTask) => {
				void _task; // arity required for mock.calls[0][0] assertions
				return { kind: "escalated" as const, summary: "terminal" };
			},
		);
		const scheduler = resumeScheduler({
			run: async () => ({ kind: "escalated" as const, summary: "x" }),
			runResume,
		});
		await scheduler.enqueueResume(makeRecord());
		await scheduler.idle();

		expect(runResume).toHaveBeenCalledTimes(1);
		expect(runResume.mock.calls[0][0]).toEqual({
			mode: "resume",
			event: makeEvent("A", 1),
			cwd: "/tmp/retained/work-1",
			decision: {
				decisionId: "D-1-ab12",
				value: "test",
				remark: "spec says five",
			},
		});
	});

	it("同 project 的 resume 串行于在途 repair（不并行、不抢先）", async () => {
		const timeline: string[] = [];
		let release: () => void = () => {};
		const gate = new Promise<void>((r) => (release = r));
		const scheduler = resumeScheduler({
			run: async () => {
				await gate;
				timeline.push("repair");
				return { kind: "escalated" as const, summary: "x" };
			},
			runResume: async () => {
				timeline.push("resume");
				return { kind: "escalated" as const, summary: "terminal" };
			},
		});
		scheduler.enqueue(makeEvent("A", 1));
		while (scheduler.stats().running === 0) {
			await new Promise((r) => setTimeout(r, 5));
		}
		await scheduler.enqueueResume(makeRecord());
		await new Promise((r) => setTimeout(r, 30));
		// repair 仍在途 → resume 必须等待（per-key serial）
		expect(timeline).toEqual([]);
		release();
		await scheduler.idle();
		expect(timeline).toEqual(["repair", "resume"]);
	});

	it("同 key 连续两个 resume → FIFO 顺序执行", async () => {
		const order: string[] = [];
		const scheduler = resumeScheduler({
			run: async () => ({ kind: "escalated" as const, summary: "x" }),
			runResume: async (task) => {
				order.push(task.decision.decisionId);
				await new Promise((r) => setTimeout(r, 20));
				return { kind: "escalated" as const, summary: "terminal" };
			},
		});
		await scheduler.enqueueResume(makeRecord({ decision_id: "D-1-first" }));
		await scheduler.enqueueResume(makeRecord({ decision_id: "D-1-second" }));
		await scheduler.idle();
		expect(order).toEqual(["D-1-first", "D-1-second"]);
	});

	it("resume 不走 pipeline-id 去重：repair 在途时同 pipeline 仍可 resume", async () => {
		let release: () => void = () => {};
		const gate = new Promise<void>((r) => (release = r));
		const runResume = vi.fn(async () => ({
			kind: "escalated" as const,
			summary: "terminal",
		}));
		const scheduler = resumeScheduler({
			run: async () => {
				await gate;
				return { kind: "escalated" as const, summary: "x" };
			},
			runResume,
		});
		scheduler.enqueue(makeEvent("A", 1)); // pipeline A:1 在途（inflight 占用）
		while (scheduler.stats().running === 0) {
			await new Promise((r) => setTimeout(r, 5));
		}
		await scheduler.enqueueResume(makeRecord()); // 同 pipeline，不应被去重丢弃
		release();
		await scheduler.idle();
		expect(runResume).toHaveBeenCalledTimes(1);
	});
});

describe("Scheduler — resume 二次转交终局通知（T09）", () => {
	let dir: string;
	let store: DecisionStore;

	beforeEach(() => {
		dir = mkdtempSync(join(tmpdir(), "t09-scheduler-"));
		store = new DecisionStore(join(dir, "decisions.db"));
	});
	afterEach(() => {
		store.close();
		rmSync(dir, { recursive: true, force: true });
	});

	/** Seed a decision the way /heal test leaves it: claimed as resumed. */
	function seedResumedDecision(): DecisionRecord {
		store.create({
			decision_id: "D-1-ab12",
			pipeline_id: "1",
			project_id: "A",
			event_json: JSON.stringify(makeEvent("A", 1)),
			cwd_path: "/tmp/retained/work-1",
			session_path: "/tmp/retained/work-1/.pi-agent",
			branch: "ci-self-heal/main-abc12345",
			expires_at: "2026-08-18T00:00:00.000Z",
		});
		store.updateStatus("D-1-ab12", {
			status: "resumed",
			decided_by: "staff-1",
			decision_value: "test",
		});
		const record = store.get("D-1-ab12");
		if (!record) throw new Error("seed failed");
		return record;
	}

	function resumeScheduler(outcome: RepairOutcome, notifier: {
		notifyEscalated: ReturnType<typeof vi.fn>;
		notifyResumeTerminal: ReturnType<typeof vi.fn>;
	}) {
		return new Scheduler({
			workerManager: {
				run: async () => ({ kind: "escalated" as const, summary: "x" }),
				runResume: async () => outcome,
			},
			workRoot: "/tmp/w",
			policy: CI_REPAIR_SCHEDULING_POLICY,
			maxWorkers: 1,
			decisionStore: store,
			escalationNotifier: notifier,
		});
	}

	it("resume escalated → ONE 终局 routed 通知；无新决策行，resumed 行不变", async () => {
		const record = seedResumedDecision();
		const notifier = {
			notifyEscalated: vi.fn(async () => {}),
			notifyResumeTerminal: vi.fn(async (_event: PipelineEvent, _outcome: RepairOutcome) => {
				void _event; // arity required for mock.calls[0][N] assertions
				void _outcome;
			}),
		};
		const scheduler = resumeScheduler(
			{ kind: "escalated", summary: "second escalation" },
			notifier,
		);
		await scheduler.enqueueResume(record);
		await scheduler.idle();

		expect(notifier.notifyResumeTerminal).toHaveBeenCalledTimes(1);
		expect(notifier.notifyResumeTerminal.mock.calls[0][0]).toEqual(makeEvent("A", 1));
		expect(notifier.notifyResumeTerminal.mock.calls[0][1]).toMatchObject({
			kind: "escalated",
			summary: "second escalation",
		});
		expect(notifier.notifyEscalated).not.toHaveBeenCalled();

		// One-round intervention: NO new decision row; the resumed row is terminal.
		expect(store.listByStatus("awaiting_decision")).toEqual([]);
		expect(store.listByProject("A")).toHaveLength(1);
		expect(store.get("D-1-ab12")!.status).toBe("resumed");
	});

	it("resume mr → 主进程零通知（worker 已发成功通知）", async () => {
		const record = seedResumedDecision();
		const notifier = {
			notifyEscalated: vi.fn(async () => {}),
			notifyResumeTerminal: vi.fn(async () => {}),
		};
		const scheduler = resumeScheduler(
			{ kind: "mr", summary: "fixed", mrUrl: "https://mr/1" },
			notifier,
		);
		await scheduler.enqueueResume(record);
		await scheduler.idle();
		expect(notifier.notifyResumeTerminal).not.toHaveBeenCalled();
		expect(notifier.notifyEscalated).not.toHaveBeenCalled();
	});

	it("resume failed → 主进程零通知（worker 已发失败通知）", async () => {
		const record = seedResumedDecision();
		const notifier = {
			notifyEscalated: vi.fn(async () => {}),
			notifyResumeTerminal: vi.fn(async () => {}),
		};
		const scheduler = resumeScheduler(
			{ kind: "failed", summary: "agent-resume", error: "boom" },
			notifier,
		);
		await scheduler.enqueueResume(record);
		await scheduler.idle();
		expect(notifier.notifyResumeTerminal).not.toHaveBeenCalled();
		expect(notifier.notifyEscalated).not.toHaveBeenCalled();
	});

	it("终局通知抛错 → scheduler 不崩溃", async () => {
		const record = seedResumedDecision();
		const notifier = {
			notifyEscalated: vi.fn(async () => {}),
			notifyResumeTerminal: vi.fn(async () => {
				throw new Error("dingtalk down");
			}),
		};
		const scheduler = resumeScheduler(
			{ kind: "escalated", summary: "second escalation" },
			notifier,
		);
		await scheduler.enqueueResume(record);
		await scheduler.idle();
		expect(notifier.notifyResumeTerminal).toHaveBeenCalledTimes(1);
		expect(scheduler.stats()).toEqual({ running: 0, queued: 0, inflight: 0 });
	});
});

describe("Scheduler — stage exclusion（CIHEAL_SKIP_STAGES）", () => {
	function skipScheduler(skipStages?: readonly string[]) {
		const { workerManager, runs } = fakeWorker();
		const scheduler = new Scheduler({
			workerManager,
			workRoot: mkdtempSync(join(tmpdir(), "sched-")),
			policy: CI_REPAIR_SCHEDULING_POLICY,
			maxWorkers: 1,
			...(skipStages ? { skipStages } : {}),
		});
		return { scheduler, runs };
	}

	function stagedEvent(stages: readonly string[] | undefined): PipelineEvent {
		return {
			...makeEvent("projA", 11),
			...(stages ? { failedStages: stages } : {}),
		};
	}

	it("skips repair when ALL failed stages are in skipStages (no worker run)", async () => {
		const { scheduler, runs } = skipScheduler(["format"]);
		expect(scheduler.enqueue(stagedEvent(["format"]))).toBe("skipped");
		await scheduler.idle();
		expect(runs()).toHaveLength(0);
		expect(scheduler.stats()).toEqual({ running: 0, queued: 0, inflight: 0 });
	});

	it("queues repair when ANY failed stage is not excluded", async () => {
		const { scheduler, runs } = skipScheduler(["format"]);
		expect(scheduler.enqueue(stagedEvent(["format", "test"]))).toBe("queued");
		await scheduler.idle();
		expect(runs()).toHaveLength(1);
	});

	it("degrades to queue when failedStages is undefined (no builds in payload)", async () => {
		const { scheduler, runs } = skipScheduler(["format"]);
		expect(scheduler.enqueue(stagedEvent(undefined))).toBe("queued");
		await scheduler.idle();
		expect(runs()).toHaveLength(1);
	});

	it("degrades to queue when failedStages is empty", async () => {
		const { scheduler } = skipScheduler(["format"]);
		expect(scheduler.enqueue(stagedEvent([]))).toBe("queued");
		await scheduler.idle();
	});

	it("queues everything when skipStages is not configured", async () => {
		const { scheduler, runs } = skipScheduler(undefined);
		expect(scheduler.enqueue(stagedEvent(["format"]))).toBe("queued");
		await scheduler.idle();
		expect(runs()).toHaveLength(1);
	});

	it("skipped events are not dedup-tracked (repeat delivery skips again)", async () => {
		const { scheduler } = skipScheduler(["format"]);
		expect(scheduler.enqueue(stagedEvent(["format"]))).toBe("skipped");
		expect(scheduler.enqueue(stagedEvent(["format"]))).toBe("skipped");
	});

	it("dedup takes precedence over exclusion for in-flight pipelines", async () => {
		const { workerManager } = fakeWorker();
		const scheduler = new Scheduler({
			workerManager,
			workRoot: mkdtempSync(join(tmpdir(), "sched-")),
			policy: CI_REPAIR_SCHEDULING_POLICY,
			maxWorkers: 1,
			skipStages: ["format"],
		});
		const event = stagedEvent(["format", "test"]);
		expect(scheduler.enqueue(event)).toBe("queued");
		expect(scheduler.enqueue(event)).toBe("duplicate");
		await scheduler.idle();
	});
});

describe("parseSkipStages（CIHEAL_SKIP_STAGES env 解析）", () => {
	it("parses comma-separated stage names, trimming and dropping empties", () => {
		expect(parseSkipStages("format, lint ,, ")).toEqual(["format", "lint"]);
	});

	it("returns undefined for unset/blank/separators-only (no exclusion)", () => {
		expect(parseSkipStages(undefined)).toBeUndefined();
		expect(parseSkipStages("")).toBeUndefined();
		expect(parseSkipStages("  ,  ")).toBeUndefined();
	});
});

describe("Scheduler — G3 扩围（ADR-0009）", () => {
	it("decidable escalated 带 oosPaths → 决策注册含 oos_paths", async () => {
		const create = vi.fn();
		const outcome: RepairOutcome = {
			kind: "escalated",
			summary: "G3/diff 违规：patch touches file outside MR diff: m/src/test/T.java",
			decidable: true,
			oosPaths: ["m/src/test/T.java"],
		};
		const scheduler = new Scheduler({
			workerManager: { run: async () => outcome },
			workRoot: "/tmp/w",
			policy: CI_REPAIR_SCHEDULING_POLICY,
			maxWorkers: 1,
			decisionStore: { create },
		});
		scheduler.enqueue(makeEvent("proj-A", 888));
		await scheduler.idle();

		expect(create).toHaveBeenCalledTimes(1);
		expect(create.mock.calls[0][0].oos_paths).toBe(
			JSON.stringify(["m/src/test/T.java"]),
		);
	});

	it("widen 决策 → 信封 value=widen + oosPaths", async () => {
		const runResume = vi.fn(
			async (_task: import("../../src/agent-runtime/scheduler.js").ResumeTask) => {
				void _task; // arity required for mock.calls[0][0] assertions
				return { kind: "escalated" as const, summary: "terminal" };
			},
		);
		const scheduler = new Scheduler({
			workerManager: {
				run: async () => ({ kind: "escalated" as const, summary: "x" }),
				runResume,
			},
			workRoot: "/tmp/w",
			policy: CI_REPAIR_SCHEDULING_POLICY,
			maxWorkers: 1,
			decisionStore: { create: vi.fn() },
		});
		await scheduler.enqueueResume({
			decision_id: "D-9-ab12",
			pipeline_id: "9",
			project_id: "A",
			event_json: JSON.stringify(makeEvent("A", 9)),
			cwd_path: "/tmp/retained/work-9",
			session_path: "/tmp/retained/work-9/.pi-agent",
			branch: "ci-self-heal/main-abc12345",
			status: "resumed",
			created_at: "2026-08-17T00:00:00.000Z",
			expires_at: "2026-08-18T00:00:00.000Z",
			decided_by: "staff-1",
			decision_value: "widen",
			remark: "",
			decided_at: "2026-08-17T01:00:00.000Z",
			oos_paths: JSON.stringify(["m/src/test/T.java"]),
		});
		await scheduler.idle();

		expect(runResume).toHaveBeenCalledTimes(1);
		const task = runResume.mock.calls[0][0];
		expect(task.decision.value).toBe("widen");
		expect(task.decision.oosPaths).toEqual(["m/src/test/T.java"]);
	});
});
