import { spawn } from "node:child_process";
import { describe, expect, it, vi, afterEach } from "vitest";
import { dispatchIpcMessage } from "../../src/dashboard/ipc-dispatch.js";
import { EventHub } from "../../src/dashboard/event-hub.js";
import { MetricsAggregator } from "../../src/dashboard/metrics-aggregator.js";
import { isWorkerIpcMessage, sendIpc, type WorkerIpcMessage } from "../../src/dashboard/ipc-types.js";

describe("isWorkerIpcMessage", () => {
	it("accepts valid stage_enter", () => {
		expect(
			isWorkerIpcMessage({ type: "stage_enter", stage: "agent-run", pipelineId: 1, projectId: "p" }),
		).toBe(true);
	});

	it("accepts valid turn_end", () => {
		expect(
			isWorkerIpcMessage({ type: "turn_end", turn: 3, tokens: 1000, cost: 0.001 }),
		).toBe(true);
	});

	it("accepts valid control_ack", () => {
		expect(isWorkerIpcMessage({ type: "control_ack", controlType: "supersede" })).toBe(
			true,
		);
	});

	it("rejects non-object", () => {
		expect(isWorkerIpcMessage("hello")).toBe(false);
		expect(isWorkerIpcMessage(null)).toBe(false);
	});

	it("rejects unknown type", () => {
		expect(isWorkerIpcMessage({ type: "unknown" })).toBe(false);
	});

	it("accepts valid metrics_record", () => {
		expect(
			isWorkerIpcMessage({
				type: "metrics_record",
				projectId: "p",
				pipelineId: 42,
				outcome: "mr",
				turns: 3,
				tokens: 1500,
				cost: 0.002,
				durationMs: 12000,
				createdAt: "2026-01-01T00:00:00Z",
			}),
		).toBe(true);
	});

	it("rejects metrics_record with missing fields", () => {
		expect(
			isWorkerIpcMessage({ type: "metrics_record", projectId: "p" }),
		).toBe(false);
	});
});

describe("dispatchIpcMessage", () => {
	const workerId = "proj-1-42";

	function ctx() {
		const eventHub = new EventHub();
		const metricsAggregator = new MetricsAggregator();
		const emitted: Array<{ type: string; data: unknown }> = [];
		const emitSpy = vi.spyOn(eventHub, "emit").mockImplementation((event) => {
			emitted.push(event);
		});
		const updateSpy = vi.spyOn(eventHub, "updateSnapshot");
		const progressSpy = vi.spyOn(eventHub, "workerProgress");
		const recordSpy = vi.spyOn(metricsAggregator, "record");
		const snapshotSpy = vi.spyOn(metricsAggregator, "snapshot").mockReturnValue({
			count: 1,
			successCount: 1,
			escalationCount: 0,
			failureCount: 0,
			successRate: 1,
			escalationRate: 0,
			failureRate: 0,
			avgDurationMs: 1000,
			totalTokens: 500,
			totalCost: 0.001,
		});
		return {
			dispatch: (msg: WorkerIpcMessage) =>
				dispatchIpcMessage({ eventHub, metricsAggregator, workerId }, msg),
			emitted,
			emitSpy,
			updateSpy,
			progressSpy,
			recordSpy,
			snapshotSpy,
		};
	}

	it("stage_enter → worker_progress with stage and ids", () => {
		const { dispatch, emitted } = ctx();
		dispatch({ type: "stage_enter", stage: "agent-run", pipelineId: 42, projectId: "proj-1" });
		expect(emitted).toEqual([
			{
				type: "worker_progress",
				data: { workerId, stage: "agent-run", pipelineId: 42, projectId: "proj-1" },
			},
		]);
	});

	it("stage_exit → worker_progress with stageExit", () => {
		const { dispatch, emitted } = ctx();
		dispatch({ type: "stage_exit", stage: "verify" });
		expect(emitted).toEqual([
			{ type: "worker_progress", data: { workerId, stageExit: "verify" } },
		]);
	});

	it("turn_start → worker_progress with turn", () => {
		const { dispatch, emitted } = ctx();
		dispatch({ type: "turn_start", turn: 2 });
		expect(emitted).toEqual([
			{ type: "worker_progress", data: { workerId, turn: 2 } },
		]);
	});

	it("turn_end → worker_progress with turn and tokens", () => {
		const { dispatch, emitted } = ctx();
		dispatch({ type: "turn_end", turn: 3, tokens: 900, cost: 0.002 });
		expect(emitted).toEqual([
			{ type: "worker_progress", data: { workerId, turn: 3, tokens: 900 } },
		]);
	});

	it("tool_call → worker_progress with toolCall name", () => {
		const { dispatch, emitted } = ctx();
		dispatch({ type: "tool_call", name: "read", summary: "ci-log.txt" });
		expect(emitted).toEqual([
			{ type: "worker_progress", data: { workerId, toolCall: "read" } },
		]);
	});

	it("stage/turn/tool 进度同步写入 EventHub worker 注册表（迟到客户端可见）", () => {
		const { dispatch, progressSpy } = ctx();
		dispatch({ type: "stage_enter", stage: "agent-run", pipelineId: 42, projectId: "proj-1" });
		dispatch({ type: "turn_start", turn: 2 });
		dispatch({ type: "turn_end", turn: 2, tokens: 900, cost: 0.002 });
		dispatch({ type: "tool_call", name: "read", summary: "ci-log.txt" });
		expect(progressSpy).toHaveBeenNthCalledWith(1, workerId, {
			stage: "agent-run",
			pipelineId: 42,
			projectId: "proj-1",
		});
		expect(progressSpy).toHaveBeenNthCalledWith(2, workerId, { turn: 2 });
		expect(progressSpy).toHaveBeenNthCalledWith(3, workerId, { turn: 2, tokens: 900 });
		expect(progressSpy).toHaveBeenNthCalledWith(4, workerId, { toolCall: "read" });
	});

	it("metrics_record → records metrics, updates snapshot, emits metrics_update", () => {
		const { dispatch, emitted, recordSpy, updateSpy, snapshotSpy } = ctx();
		const record = {
			type: "metrics_record" as const,
			projectId: "proj-1",
			pipelineId: 42,
			outcome: "mr",
			turns: 2,
			tokens: 800,
			cost: 0.001,
			durationMs: 5000,
			createdAt: "2026-01-01T00:00:00Z",
		};
		dispatch(record);
		expect(recordSpy).toHaveBeenCalledWith({
			projectId: "proj-1",
			pipelineId: 42,
			outcome: "mr",
			turns: 2,
			tokens: 800,
			cost: 0.001,
			durationMs: 5000,
			createdAt: "2026-01-01T00:00:00Z",
		});
		expect(snapshotSpy).toHaveBeenCalled();
		expect(updateSpy).toHaveBeenCalledWith({ metrics: snapshotSpy.mock.results[0]?.value });
		expect(emitted).toEqual([{ type: "metrics_update", data: snapshotSpy.mock.results[0]?.value }]);
	});
});

describe("IPC integration", () => {
	it("receives IPC messages from child process via spawn with ipc stdio", async () => {
		const messages: unknown[] = [];
		const child = spawn(
			process.execPath,
			["--input-type=module", "-e", `process.send({ type: "stage_enter", stage: "test", pipelineId: 1, projectId: "p" }); setTimeout(() => process.exit(0), 100);`],
			{ stdio: ["ignore", "pipe", "pipe", "ipc"] },
		);

		child.on("message", (msg) => messages.push(msg));
		await new Promise<void>((resolve) => child.on("close", () => resolve()));

		expect(messages).toHaveLength(1);
		expect(isWorkerIpcMessage(messages[0])).toBe(true);
		expect(messages[0]).toMatchObject({ type: "stage_enter", stage: "test" });
	});
});

describe("sendIpc 门控", () => {
	// vitest forks 池里 process.send 真实存在（指向 tinypool 通道）——
	// 测试期间覆写它，结束后必须还原，否则破坏 vitest 自身 IPC。
	const savedFlag = process.env.CIHEAL_WORKER_IPC;
	const savedSend = process.send;

	afterEach(() => {
		if (savedFlag === undefined) delete process.env.CIHEAL_WORKER_IPC;
		else process.env.CIHEAL_WORKER_IPC = savedFlag;
		(process as { send?: unknown }).send = savedSend;
	});

	it("仅在 CIHEAL_WORKER_IPC=1 时发送——manager 接线 IPC 通道时的显式标志", () => {
		const send = vi.fn();
		(process as { send?: unknown }).send = send;

		delete process.env.CIHEAL_WORKER_IPC;
		sendIpc({ type: "stage_exit", stage: "probe" });
		expect(send).not.toHaveBeenCalled();

		process.env.CIHEAL_WORKER_IPC = "1";
		sendIpc({ type: "stage_exit", stage: "probe" });
		expect(send).toHaveBeenCalledWith({ type: "stage_exit", stage: "probe" });
	});

	it("有标志但无 process.send 时静默不抛", () => {
		(process as { send?: unknown }).send = undefined;
		process.env.CIHEAL_WORKER_IPC = "1";
		expect(() => sendIpc({ type: "stage_exit", stage: "probe" })).not.toThrow();
	});
});
