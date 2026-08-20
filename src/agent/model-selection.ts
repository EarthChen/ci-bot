import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { logger } from "../util/log.js";

/** Thinking levels accepted by Pi — mirrors the SDK's `ThinkingLevel`. */
export type ThinkingLevel =
	| "off"
	| "minimal"
	| "low"
	| "medium"
	| "high"
	| "xhigh"
	| "max";

/** Per-model run policy inlined into each candidate (thinking + compaction).
 *
 * 压缩触发点 = contextWindow − reserveTokens（pi shouldCompact 公式）。
 * contextWindow 来自部署侧 models.json（qwen3.8-max 声明 256000），因此
 * reserveTokens 编码的是“希望多早触发压缩”：106000 = 256000 − 150000，
 * 即 context 长到 ~150k token 就自动压缩（keepRecentTokens 保留近尾）。
 * 调整窗口声明时必须同步重算此值。 */
export interface ModelCandidateCompaction {
	readonly enabled?: boolean;
	readonly reserveTokens?: number;
	readonly keepRecentTokens?: number;
}

/** A non-secret provider/model candidate owned by the bot deployment. */
export interface ModelCandidate {
	readonly provider: string;
	readonly model: string;
	readonly defaultThinkingLevel: ThinkingLevel;
	readonly compaction?: ModelCandidateCompaction;
}

/** Minimal runtime seam used to select a model without coupling tests to Pi internals. */
export interface ModelRuntimeForSelection<
	TModel extends { readonly id: string },
> {
	getModel(provider: string, model: string): TModel | undefined;
	getAvailable(provider?: string): Promise<readonly TModel[]>;
}

export interface SelectedModelCandidate<
	TModel extends { readonly id: string },
> {
	readonly candidate: ModelCandidate;
	readonly model: TModel;
}

const DEFAULT_CONFIG_DIR = resolve(
	dirname(fileURLToPath(import.meta.url)),
	"../../config",
);
const DEFAULT_CANDIDATES_PATH = resolve(
	DEFAULT_CONFIG_DIR,
	"model-candidates.json",
);

/** Error raised when no configured candidate can be used by the worker. */
class NoAvailableModelError extends Error {
	constructor(candidates: readonly ModelCandidate[]) {
		super(
			`no available model candidate; checked ${candidates
				.map(({ provider, model }) => `${provider}/${model}`)
				.join(", ")}`,
		);
		this.name = "NoAvailableModelError";
	}
}

/** Read and validate the bot-owned provider/model candidate file. */
export function loadModelCandidates(
	path = DEFAULT_CANDIDATES_PATH,
): readonly ModelCandidate[] {
	let parsed: unknown;
	try {
		parsed = JSON.parse(readFileSync(path, "utf8")) as unknown;
	} catch (error) {
		throw new Error(`failed to load model candidates from ${path}`, {
			cause: error,
		});
	}
	if (!Array.isArray(parsed) || parsed.length === 0) {
		throw new Error(`model candidates must be a non-empty array: ${path}`);
	}

	const seen = new Set<string>();
	return parsed.map((entry, index) => {
		if (!isModelCandidate(entry)) {
			throw new Error(`invalid model candidate at index ${index}: ${path}`);
		}
		const identity = `${entry.provider}/${entry.model}`;
		if (seen.has(identity)) {
			throw new Error(`duplicate model candidate ${identity}: ${path}`);
		}
		seen.add(identity);
		return entry;
	});
}

/** Select the first candidate whose concrete model is usable. */
export async function selectModelCandidate<
	TModel extends { readonly id: string },
>(
	runtime: ModelRuntimeForSelection<TModel>,
	candidates: readonly ModelCandidate[],
): Promise<SelectedModelCandidate<TModel>> {
	for (const candidate of candidates) {
		const model = runtime.getModel(candidate.provider, candidate.model);
		if (!model) {
			logger.warn(
				{ provider: candidate.provider, model: candidate.model },
				"model candidate is not registered",
			);
			continue;
		}

		let available = false;
		try {
			const models = await runtime.getAvailable(candidate.provider);
			available = models.some(
				(availableModel) => availableModel.id === model.id,
			);
		} catch {
			logger.warn(
				{ provider: candidate.provider, model: candidate.model },
				"model candidate availability check failed",
			);
			// An unavailable candidate must not prevent trying the next one.
		}
		if (available) return { candidate, model };
	}
	throw new NoAvailableModelError(candidates);
}

function isModelCandidate(value: unknown): value is ModelCandidate {
	if (!value || typeof value !== "object") return false;
	const entry = value as Record<string, unknown>;
	return (
		typeof entry.provider === "string" &&
		entry.provider.trim() !== "" &&
		typeof entry.model === "string" &&
		entry.model.trim() !== "" &&
		typeof entry.defaultThinkingLevel === "string" &&
		isThinkingLevel(entry.defaultThinkingLevel) &&
		(entry.compaction === undefined || isCompaction(entry.compaction))
	);
}

function isThinkingLevel(value: unknown): boolean {
	return (
		value === "off" ||
		value === "minimal" ||
		value === "low" ||
		value === "medium" ||
		value === "high" ||
		value === "xhigh" ||
		value === "max"
	);
}

function isCompaction(value: unknown): boolean {
	if (!value || typeof value !== "object" || Array.isArray(value)) return false;
	const compaction = value as Record<string, unknown>;
	if (
		compaction.enabled !== undefined &&
		typeof compaction.enabled !== "boolean"
	) {
		return false;
	}
	return ["reserveTokens", "keepRecentTokens"].every((key) => {
		const entry = compaction[key];
		return (
			entry === undefined ||
			(typeof entry === "number" && Number.isFinite(entry) && entry > 0)
		);
	});
}
