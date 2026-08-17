/**
 * CI Repair structured result parser.
 *
 * Parses the JSON block the CI Repair agent is instructed to output at the
 * end of its session. Validates failureClass ∈ {1,2,3,4,5} and normalizes
 * the result into a well-formed AgentResult.
 *
 * This parser is CI-specific — other Vertical Agents define their own.
 */

import type { AgentResult, Diagnosis, FailureClass } from "../../types.js";

/** Parse the JSON block from the agent's final assistant message. */
export function tryParseAgentJson(text: string): AgentResult | null {
	let candidate = text;
	const fenceMatch = text.match(/```(?:json)?\s*\n?([\s\S]*?)\n?```/);
	if (fenceMatch?.[1]) candidate = fenceMatch[1];
	try {
		const obj = JSON.parse(candidate) as Partial<AgentResult>;
		return normalizeAgentResult(obj);
	} catch {
		return null;
	}
}

function normalizeAgentResult(obj: Partial<AgentResult>): AgentResult | null {
	const diagnosis = normalizeDiagnosis(obj.diagnosis);
	if (obj.kind === "fixed" && diagnosis && typeof obj.summary === "string") {
		return {
			kind: "fixed",
			diagnosis,
			summary: obj.summary,
			mrUrl: typeof obj.mrUrl === "string" ? obj.mrUrl : undefined,
		};
	}
	if (obj.kind === "escalated" && diagnosis && typeof obj.reason === "string") {
		return { kind: "escalated", diagnosis, reason: obj.reason, source: "agent" };
	}
	return null;
}

function normalizeDiagnosis(value: unknown): Diagnosis | null {
	if (!value || typeof value !== "object") return null;
	const candidate = value as { failureClass?: unknown; summary?: unknown };
	if (!isFailureClass(candidate.failureClass)) return null;
	if (typeof candidate.summary !== "string") return null;
	return { failureClass: candidate.failureClass, summary: candidate.summary };
}

function isFailureClass(value: unknown): value is FailureClass {
	return (
		value === 1 || value === 2 || value === 3 || value === 4 || value === 5
	);
}
