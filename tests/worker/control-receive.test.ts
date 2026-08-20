/**
 * Ticket 05 slice 4: worker 侧收到控制消息后留下可观测痕迹（审计日志 + IPC ack）。
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { handleWorkerControlMessage } from "../../src/worker/control-listener.js";
import { sendIpc } from "../../src/dashboard/ipc-types.js";
import { logger } from "../../src/util/log.js";

vi.mock("../../src/dashboard/ipc-types.js", async (importOriginal) => {
	const actual = await importOriginal<typeof import("../../src/dashboard/ipc-types.js")>();
	return { ...actual, sendIpc: vi.fn() };
});

describe("handleWorkerControlMessage", () => {
	const savedFlag = process.env.CIHEAL_WORKER_IPC;

	afterEach(() => {
		if (savedFlag === undefined) delete process.env.CIHEAL_WORKER_IPC;
		else process.env.CIHEAL_WORKER_IPC = savedFlag;
		vi.mocked(sendIpc).mockClear();
	});

	it("CIHEAL_WORKER_IPC=1 时收到 supersede → 记审计日志并 ack", () => {
		process.env.CIHEAL_WORKER_IPC = "1";
		const infoSpy = vi.spyOn(logger, "info").mockImplementation(() => logger);

		const msg = {
			type: "supersede" as const,
			payload: { oldSha: "aaa", newSha: "bbb", newPipelineId: 999 },
		};
		handleWorkerControlMessage(msg);

		expect(infoSpy).toHaveBeenCalledWith(
			{ control: msg },
			"worker control message received",
		);
		expect(sendIpc).toHaveBeenCalledWith({
			type: "control_ack",
			controlType: "supersede",
		});
		infoSpy.mockRestore();
	});

	it("无 CIHEAL_WORKER_IPC 标志时不处理", () => {
		delete process.env.CIHEAL_WORKER_IPC;
		const infoSpy = vi.spyOn(logger, "info").mockImplementation(() => logger);

		handleWorkerControlMessage({ type: "supersede", payload: { oldSha: "a", newSha: "b", newPipelineId: 1 } });

		expect(infoSpy).not.toHaveBeenCalled();
		expect(sendIpc).not.toHaveBeenCalled();
		infoSpy.mockRestore();
	});

	it("忽略 worker→main 进度消息（不当作控制消息）", () => {
		process.env.CIHEAL_WORKER_IPC = "1";
		const infoSpy = vi.spyOn(logger, "info").mockImplementation(() => logger);

		handleWorkerControlMessage({ type: "stage_exit", stage: "agent-run" });

		expect(infoSpy).not.toHaveBeenCalled();
		expect(sendIpc).not.toHaveBeenCalled();
		infoSpy.mockRestore();
	});
});
