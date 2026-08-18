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
		provider: "amar-coding-plan",
		model: "qwen3.8-max",
		defaultThinkingLevel: "medium",
		compaction: {
			enabled: true,
			reserveTokens: 32768,
			keepRecentTokens: 40000,
		},
	},
];

describe("loadModelCandidates", () => {
	it("loads a non-empty candidate list with valid inline policy (shape, not content)", () => {
		const loaded = loadModelCandidates("config/model-candidates.json");
		expect(loaded.length).toBeGreaterThan(0);
		const seen = new Set<string>();
		for (const c of loaded) {
			expect(typeof c.provider).toBe("string");
			expect(c.provider.length).toBeGreaterThan(0);
			expect(typeof c.model).toBe("string");
			expect(c.model.length).toBeGreaterThan(0);
			expect(["off", "minimal", "low", "medium", "high", "xhigh", "max"]).toContain(
				c.defaultThinkingLevel,
			);
			const identity = `${c.provider}/${c.model}`;
			expect(seen.has(identity)).toBe(false); // 候选不重复
			seen.add(identity);
			if (c.compaction != null) {
				expect(typeof c.compaction.enabled).toBe("boolean");
				expect(c.compaction.reserveTokens).toBeGreaterThan(0);
				expect(c.compaction.keepRecentTokens).toBeGreaterThan(0);
			}
		}
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
	const selectionCandidates: readonly ModelCandidate[] = [
		{
			provider: "amar-coding-plan",
			model: "qwen3.8-max",
			defaultThinkingLevel: "high",
		},
		{
			provider: "amar-coding-plan",
			model: "qwen3.8-fallback",
			defaultThinkingLevel: "high",
		},
	];

	it("selects the first available model without key injection", async () => {
		const runtime = fakeRuntime({
			models: {
				"amar-coding-plan/qwen3.8-max": undefined,
				"amar-coding-plan/qwen3.8-fallback": { id: "qwen3.8-fallback" },
			},
			available: ["qwen3.8-fallback"],
		});

		const selected = await selectModelCandidate(
			runtime,
			selectionCandidates,
		);

		expect(selected.candidate).toEqual(selectionCandidates[1]);
		expect(selected.model).toEqual({ id: "qwen3.8-fallback" });
	});

	it("fails loudly when no candidate has an available model", async () => {
		const runtime = fakeRuntime({ models: {}, available: [] });

		await expect(selectModelCandidate(runtime, candidates)).rejects.toThrow(
			"no available model candidate",
		);
	});
});
