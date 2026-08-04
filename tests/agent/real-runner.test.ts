import { describe, expect, it } from "vitest";
import {
	RealAgentRunner,
	tryParseAgentJson,
} from "../../src/agent/real-runner.js";

const input = {
	projectId: "group/project",
	pipelineId: 42,
	ref: "main",
	sha: "0123456789abcdef",
	ciLog: "no model available",
	mrDiff: "",
	cwd: "/tmp/ci-heal-test",
};

describe("RealAgentRunner", () => {
	it("rejects invalid G1 failure classes from agent output", () => {
		expect(
			tryParseAgentJson(
				'{"kind":"fixed","diagnosis":{"failureClass":6,"summary":"bad"},"summary":"bad"}',
			),
		).toBeNull();
	});

	it("escalates when no provider/model can initialize a session", async () => {
		const runner = new RealAgentRunner({
			sessionFactory: async () => {
				throw new Error("no available model candidate");
			},
		});

		await expect(runner.run(input)).resolves.toMatchObject({
			kind: "escalated",
			diagnosis: {
				failureClass: 4,
			},
		});
	});
});
