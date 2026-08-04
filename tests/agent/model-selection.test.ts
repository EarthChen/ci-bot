import { describe, expect, it } from "vitest";
import {
	loadModelCandidates,
	loadModelProfiles,
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
}): ModelRuntimeForSelection<FakeModel> & { readonly injected: string[] } {
	const injected: string[] = [];
	return {
		injected,
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
		async setRuntimeApiKey(provider, apiKey) {
			injected.push(`${provider}:${apiKey}`);
		},
	};
}

const candidates: readonly ModelCandidate[] = [
	{
		provider: "deepseek",
		model: "deepseek-chat",
		keyEnv: "DEEPSEEK_API_KEY",
		profile: "deepseek-chat",
	},
	{
		provider: "deepseek",
		model: "deepseek-reasoner",
		keyEnv: "DEEPSEEK_API_KEY",
		profile: "deepseek-reasoner",
	},
];

describe("loadModelCandidates", () => {
	it("loads the bot-owned candidate list", () => {
		expect(loadModelCandidates("config/model-candidates.json")).toEqual(
			candidates,
		);
	});
});

describe("loadModelProfiles", () => {
	it("loads per-model thinking and compaction policies", () => {
		expect(loadModelProfiles("config/model-profiles.json")).toMatchObject({
			"deepseek-reasoner": {
				defaultThinkingLevel: "high",
				compaction: {
					reserveTokens: 32768,
				},
			},
		});
	});
});

describe("selectModelCandidate", () => {
	it("selects the first available model and injects its provider key", async () => {
		const runtime = fakeRuntime({
			models: {
				"deepseek/deepseek-chat": undefined,
				"deepseek/deepseek-reasoner": { id: "deepseek-reasoner" },
			},
			available: ["deepseek-reasoner"],
		});

		const selected = await selectModelCandidate(runtime, candidates, {
			DEEPSEEK_API_KEY: "deepseek-secret",
		});

		expect(selected.candidate).toEqual(candidates[1]);
		expect(selected.model).toEqual({ id: "deepseek-reasoner" });
		expect(runtime.injected).toEqual(["deepseek:deepseek-secret"]);
	});

	it("fails loudly when no candidate has an available model", async () => {
		const runtime = fakeRuntime({ models: {}, available: [] });

		await expect(selectModelCandidate(runtime, candidates, {})).rejects.toThrow(
			"no available model candidate",
		);
	});
});
