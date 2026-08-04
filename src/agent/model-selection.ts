import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type { SettingsManager } from "@earendil-works/pi-coding-agent";
import { logger } from "../util/log.js";

/** Pi settings that are safe to vary with a selected model. */
export type ModelProfile = Pick<
	Parameters<SettingsManager["applyOverrides"]>[0],
	"defaultThinkingLevel" | "thinkingBudgets" | "compaction"
>;

/** A non-secret provider/model candidate owned by the bot deployment. */
export interface ModelCandidate {
	readonly provider: string;
	readonly model: string;
	readonly keyEnv: string;
	readonly profile: string;
}

/** Minimal runtime seam used to select a model without coupling tests to Pi internals. */
export interface ModelRuntimeForSelection<
	TModel extends { readonly id: string },
> {
	getModel(provider: string, model: string): TModel | undefined;
	getAvailable(provider?: string): Promise<readonly TModel[]>;
	setRuntimeApiKey(provider: string, apiKey: string): Promise<void>;
	removeRuntimeApiKey?(provider: string): Promise<void>;
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
const DEFAULT_PROFILES_PATH = resolve(
	DEFAULT_CONFIG_DIR,
	"model-profiles.json",
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

/** Read and validate the bot-owned Pi-compatible model profiles. */
export function loadModelProfiles(
	path = DEFAULT_PROFILES_PATH,
): Readonly<Record<string, ModelProfile>> {
	let parsed: unknown;
	try {
		parsed = JSON.parse(readFileSync(path, "utf8")) as unknown;
	} catch (error) {
		throw new Error(`failed to load model profiles from ${path}`, {
			cause: error,
		});
	}
	if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
		throw new Error(`model profiles must be an object: ${path}`);
	}

	const profiles: Record<string, ModelProfile> = {};
	for (const [name, profile] of Object.entries(parsed)) {
		if (!isModelProfile(profile)) {
			throw new Error(`invalid model profile ${name}: ${path}`);
		}
		profiles[name] = profile;
	}
	return profiles;
}

/** Select the first candidate whose concrete model and credentials are usable. */
export async function selectModelCandidate<
	TModel extends { readonly id: string },
>(
	runtime: ModelRuntimeForSelection<TModel>,
	candidates: readonly ModelCandidate[],
	env: NodeJS.ProcessEnv = process.env,
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

		const apiKey = resolveApiKey(candidate, env);
		let runtimeKeyInjected = false;
		if (apiKey) {
			try {
				await runtime.setRuntimeApiKey(candidate.provider, apiKey);
				runtimeKeyInjected = true;
			} catch {
				logger.warn(
					{ provider: candidate.provider, model: candidate.model },
					"model candidate key was rejected",
				);
				continue;
			}
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
		if (runtimeKeyInjected && runtime.removeRuntimeApiKey) {
			await runtime.removeRuntimeApiKey(candidate.provider).catch(() => {
				logger.warn(
					{ provider: candidate.provider },
					"failed to clear rejected model candidate key",
				);
			});
		}
	}
	throw new NoAvailableModelError(candidates);
}

/** Resolve provider-specific credentials, retaining the legacy single-key mode. */
function resolveApiKey(
	candidate: ModelCandidate,
	env: NodeJS.ProcessEnv,
): string | undefined {
	if (env[candidate.keyEnv]?.trim()) return env[candidate.keyEnv]?.trim();
	if (
		env.MODEL_PROVIDER?.trim() === candidate.provider &&
		env.MODEL_API_KEY?.trim()
	) {
		return env.MODEL_API_KEY.trim();
	}
	return undefined;
}

function isModelCandidate(value: unknown): value is ModelCandidate {
	if (!value || typeof value !== "object") return false;
	const entry = value as Record<string, unknown>;
	return (
		typeof entry.provider === "string" &&
		entry.provider.trim() !== "" &&
		typeof entry.model === "string" &&
		entry.model.trim() !== "" &&
		typeof entry.keyEnv === "string" &&
		entry.keyEnv.trim() !== "" &&
		typeof entry.profile === "string" &&
		entry.profile.trim() !== ""
	);
}

function isModelProfile(value: unknown): value is ModelProfile {
	if (!value || typeof value !== "object" || Array.isArray(value)) return false;
	const profile = value as Record<string, unknown>;
	const allowedKeys = new Set([
		"defaultThinkingLevel",
		"thinkingBudgets",
		"compaction",
	]);
	if (Object.keys(profile).some((key) => !allowedKeys.has(key))) return false;
	if (
		profile.defaultThinkingLevel !== undefined &&
		!isThinkingLevel(profile.defaultThinkingLevel)
	) {
		return false;
	}
	if (
		profile.thinkingBudgets !== undefined &&
		!isPositiveNumberMap(profile.thinkingBudgets)
	) {
		return false;
	}
	if (profile.compaction !== undefined && !isCompaction(profile.compaction)) {
		return false;
	}
	return true;
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

function isPositiveNumberMap(value: unknown): boolean {
	if (!value || typeof value !== "object" || Array.isArray(value)) return false;
	return Object.values(value).every(
		(entry) => typeof entry === "number" && Number.isFinite(entry) && entry > 0,
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
