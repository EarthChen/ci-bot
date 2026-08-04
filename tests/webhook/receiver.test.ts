import { describe, expect, it } from "vitest";
import { parsePipelinePayload } from "../../src/webhook/receiver.js";

function failedPipeline(projectId: string | number): unknown {
	return {
		object_kind: "pipeline",
		object_attributes: {
			id: 101,
			ref: "main",
			sha: "0123456789abcdef",
			status: "failed",
		},
		project: {
			id: projectId,
			web_url: "https://gitlab.example.com/example/project",
		},
	};
}

describe("parsePipelinePayload", () => {
	it("rejects a project id that could escape the worker root", () => {
		expect(
			parsePipelinePayload(failedPipeline("../../../sensitive")),
		).toBeNull();
	});

	it("accepts GitLab numeric project ids", () => {
		expect(parsePipelinePayload(failedPipeline(12345))).toMatchObject({
			projectId: "12345",
		});
	});
});
