import { describe, expect, it } from "vitest";
import {
	isSupersedePayload,
	isWorkerControlMessage,
	type SupersedePayload,
	type WorkerControlMessage,
} from "../../src/worker/control-types.js";

describe("isWorkerControlMessage", () => {
	it("accepts supersede with valid payload", () => {
		const msg: WorkerControlMessage = {
			type: "supersede",
			payload: { oldSha: "aaa", newSha: "bbb", newPipelineId: 99 },
		};
		expect(isWorkerControlMessage(msg)).toBe(true);
	});

	it("rejects supersede with invalid payload", () => {
		expect(isWorkerControlMessage({ type: "supersede", payload: null })).toBe(false);
		expect(
			isWorkerControlMessage({ type: "supersede", payload: { reason: "new pipeline" } }),
		).toBe(false);
	});

	it("rejects non-object", () => {
		expect(isWorkerControlMessage("supersede")).toBe(false);
		expect(isWorkerControlMessage(null)).toBe(false);
	});

	it("rejects unknown type", () => {
		expect(isWorkerControlMessage({ type: "steer" })).toBe(false);
	});

	it("rejects worker→main IPC shapes (must not collide)", () => {
		expect(
			isWorkerControlMessage({ type: "stage_enter", stage: "agent-run", pipelineId: 1, projectId: "p" }),
		).toBe(false);
	});
});

describe("isSupersedePayload", () => {
	it("accepts a valid supersede payload", () => {
		const payload: SupersedePayload = {
			oldSha: "aaa111",
			newSha: "bbb222",
			newPipelineId: 42,
			changedFiles: ["src/Foo.java"],
			greenStatus: true,
		};
		expect(isSupersedePayload(payload)).toBe(true);
	});

	it("accepts minimal payload (required fields only)", () => {
		expect(
			isSupersedePayload({
				oldSha: "aaa111",
				newSha: "bbb222",
				newPipelineId: 1,
			}),
		).toBe(true);
	});

	it("rejects missing oldSha/newSha/newPipelineId", () => {
		expect(isSupersedePayload({ newSha: "b", newPipelineId: 1 })).toBe(false);
		expect(isSupersedePayload({ oldSha: "a", newPipelineId: 1 })).toBe(false);
		expect(isSupersedePayload({ oldSha: "a", newSha: "b" })).toBe(false);
	});

	it("rejects invalid optional fields", () => {
		expect(
			isSupersedePayload({
				oldSha: "a",
				newSha: "b",
				newPipelineId: 1,
				changedFiles: "not-an-array",
			}),
		).toBe(false);
		expect(
			isSupersedePayload({
				oldSha: "a",
				newSha: "b",
				newPipelineId: 1,
				greenStatus: "yes",
			}),
		).toBe(false);
	});
});
