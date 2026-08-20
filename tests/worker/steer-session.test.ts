/**
 * Ticket 06: worker-side supersede → session.steer() with merge semantics.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import {
	applySupersedeSteer,
	clearSteerSession,
	registerSteerSession,
} from "../../src/worker/steer-session.js";
import { sendIpc } from "../../src/dashboard/ipc-types.js";

vi.mock("../../src/dashboard/ipc-types.js", async (importOriginal) => {
	const actual = await importOriginal<typeof import("../../src/dashboard/ipc-types.js")>();
	return { ...actual, sendIpc: vi.fn() };
});

describe("applySupersedeSteer", () => {
	afterEach(() => {
		clearSteerSession();
		vi.mocked(sendIpc).mockClear();
	});

	it("收到 supersede → 组装 steer 文本并调用 session.steer()", async () => {
		const steered: string[] = [];
		const session = {
			steer: vi.fn(async (text: string) => {
				steered.push(text);
			}),
			clearQueue: vi.fn(async () => ({ steering: [] as string[], followUp: [] as string[] })),
			subscribe: vi.fn(() => () => {}),
		};
		registerSteerSession(session);

		await applySupersedeSteer({
			oldSha: "oldsha111",
			newSha: "newsha222",
			newPipelineId: 77,
			changedFiles: ["src/A.java"],
		});

		expect(session.steer).toHaveBeenCalledOnce();
		expect(steered[0]).toContain("旧 sha: oldsha111 → 新 sha: newsha222");
		expect(steered[0]).toContain("src/A.java");
		expect(sendIpc).toHaveBeenCalledWith({
			type: "steer_queued",
			newSha: "newsha222",
			newPipelineId: 77,
		});
	});

	it("未送达窗口内第二次 supersede → clearQueue 后 steer 最新", async () => {
		const session = {
			steer: vi.fn(async () => {}),
			clearQueue: vi.fn(async () => ({
				steering: ["stale"],
				followUp: [] as string[],
			})),
			subscribe: vi.fn(() => () => {}),
		};
		registerSteerSession(session);

		await applySupersedeSteer({
			oldSha: "a",
			newSha: "b",
			newPipelineId: 2,
		});
		await applySupersedeSteer({
			oldSha: "a",
			newSha: "c",
			newPipelineId: 3,
		});

		expect(session.clearQueue).toHaveBeenCalledOnce();
		expect(session.steer).toHaveBeenCalledTimes(2);
		expect(session.steer.mock.calls[1]![0]).toContain("新 sha: c");
	});

	it("session 未就绪时缓存 payload，register 后送达", async () => {
		const session = {
			steer: vi.fn(async () => {}),
			clearQueue: vi.fn(async () => ({ steering: [] as string[], followUp: [] as string[] })),
			subscribe: vi.fn(() => () => {}),
		};

		await applySupersedeSteer({
			oldSha: "a",
			newSha: "b",
			newPipelineId: 2,
		});
		expect(session.steer).not.toHaveBeenCalled();

		registerSteerSession(session);
		await new Promise((r) => setTimeout(r, 0));

		expect(session.steer).toHaveBeenCalledOnce();
		expect(session.steer.mock.calls[0]![0]).toContain("新 sha: b");
	});
});
