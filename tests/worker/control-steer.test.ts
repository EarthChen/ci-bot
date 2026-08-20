/**
 * Ticket 06 slice 4: control-listener delegates supersede to steer session.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { handleWorkerControlMessage } from "../../src/worker/control-listener.js";
import { sendIpc } from "../../src/dashboard/ipc-types.js";
import { logger } from "../../src/util/log.js";
import * as steerSession from "../../src/worker/steer-session.js";

vi.mock("../../src/dashboard/ipc-types.js", async (importOriginal) => {
	const actual = await importOriginal<typeof import("../../src/dashboard/ipc-types.js")>();
	return { ...actual, sendIpc: vi.fn() };
});

vi.mock("../../src/worker/steer-session.js", async (importOriginal) => {
	const actual = await importOriginal<typeof import("../../src/worker/steer-session.js")>();
	return { ...actual, applySupersedeSteer: vi.fn(async () => {}) };
});

describe("handleWorkerControlMessage — supersede steer", () => {
	const savedFlag = process.env.CIHEAL_WORKER_IPC;

	afterEach(() => {
		if (savedFlag === undefined) delete process.env.CIHEAL_WORKER_IPC;
		else process.env.CIHEAL_WORKER_IPC = savedFlag;
		vi.mocked(sendIpc).mockClear();
		vi.mocked(steerSession.applySupersedeSteer).mockClear();
	});

	it("CIHEAL_WORKER_IPC=1 时收到有效 supersede → applySupersedeSteer + ack", () => {
		process.env.CIHEAL_WORKER_IPC = "1";
		const infoSpy = vi.spyOn(logger, "info").mockImplementation(() => logger);

		const payload = {
			oldSha: "aaa",
			newSha: "bbb",
			newPipelineId: 9,
		};
		const msg = { type: "supersede" as const, payload };
		handleWorkerControlMessage(msg);

		expect(steerSession.applySupersedeSteer).toHaveBeenCalledWith(payload);
		expect(sendIpc).toHaveBeenCalledWith({
			type: "control_ack",
			controlType: "supersede",
		});
		infoSpy.mockRestore();
	});

	it("无效 payload 时不调用 applySupersedeSteer", () => {
		process.env.CIHEAL_WORKER_IPC = "1";
		handleWorkerControlMessage({ type: "supersede", payload: { bad: true } });
		expect(steerSession.applySupersedeSteer).not.toHaveBeenCalled();
		expect(sendIpc).not.toHaveBeenCalled();
	});

	it("applySupersedeSteer 失败时记录 warn 且不产生 unhandled rejection", async () => {
		process.env.CIHEAL_WORKER_IPC = "1";
		const steerErr = new Error("steer failed");
		vi.mocked(steerSession.applySupersedeSteer).mockRejectedValueOnce(steerErr);
		const warnSpy = vi.spyOn(logger, "warn").mockImplementation(() => logger);

		const unhandled: unknown[] = [];
		const onRejection = (reason: unknown) => unhandled.push(reason);
		process.on("unhandledRejection", onRejection);

		const msg = {
			type: "supersede" as const,
			payload: { oldSha: "aaa", newSha: "bbb", newPipelineId: 9 },
		};
		handleWorkerControlMessage(msg);

		await vi.waitFor(() => {
			expect(warnSpy).toHaveBeenCalledWith(
				{ err: steerErr, control: msg },
				"supersede steer apply failed",
			);
		});
		expect(unhandled).toHaveLength(0);
		expect(sendIpc).toHaveBeenCalledWith({
			type: "control_ack",
			controlType: "supersede",
		});

		process.off("unhandledRejection", onRejection);
		warnSpy.mockRestore();
	});
});
