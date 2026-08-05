import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
	loadModelCandidates,
	selectModelCandidate,
	type ModelCandidate,
	type ModelRuntimeForSelection,
} from "../../src/agent/model-selection";

interface FakeModel {
	readonly id: string;
}

function fakeRuntime(opts: {
	readonly models: Record<string, FakeModel | undefined>;
	readonly available: readonly string[];
}): ModelRuntimeForSelection<FakeModel> {
	return {
		getModel(provider, modelId) {
			return opts.models[`${provider}/${modelId}`];
		},
		async getAvailable() {
			return opts.available
				.map((id) =>
					Object.values(opts.models).find((model) => model?.id === id),
				)
				.filter((model): model is FakeModel => model !== undefined);
		},
	};
}

const candidates: readonly ModelCandidate[] = [
	{
		provider: "MOMO本地",
		model: "qwen3.7-max",
		defaultThinkingLevel: "high",
		compaction: {
			enabled: true,
			reserveTokens: 16384,
			keepRecentTokens: 20000,
		},
	},
	{
		provider: "MOMO本地",
		model: "glm-5.2",
		defaultThinkingLevel: "high",
		compaction: {
			enabled: true,
			reserveTokens: 16384,
			keepRecentTokens: 20000,
		},
	},
];

describe("loadModelCandidates", () => {
	it("loads the bot-owned candidate list with inline policy", () => {
		expect(loadModelCandidates("config/model-candidates.json")).toEqual(
			candidates,
		);
	});

	it("rejects a candidate with an invalid thinking level", () => {
		const dir = mkdtempSync(join(tmpdir(), "ci-bot-"));
		const bad = join(dir, "bad.json");
		writeFileSync(
			bad,
			JSON.stringify([
				{
					provider: "MOMO本地",
					model: "glm-5.2",
					defaultThinkingLevel: "ultra",
				},
			]),
		);
		expect(() => loadModelCandidates(bad)).toThrow();
	});
});

describe("selectModelCandidate", () => {
	it("selects the first available model without key injection", async () => {
		const runtime = fakeRuntime({
			models: {
				"MOMO本地/qwen3.7-max": undefined,
				"MOMO本地/glm-5.2": { id: "glm-5.2" },
			},
			available: ["glm-5.2"],
		});

		const selected = await selectModelCandidate(runtime, candidates);

		expect(selected.candidate).toEqual(candidates[1]);
		expect(selected.model).toEqual({ id: "glm-5.2" });
	});

	it("fails loudly when no candidate has an available model", async () => {
		const runtime = fakeRuntime({ models: {}, available: [] });

		await expect(selectModelCandidate(runtime, candidates)).rejects.toThrow(
			"no available model candidate",
		);
	});
});
