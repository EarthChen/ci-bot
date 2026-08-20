/**
 * Resume orchestration (T06) — the resume variant of runRepair.
 *
 * Skips CI-log fetch, class-5 filter, worktree creation and the initial
 * agent.run — the retained scene already carries all of them. Starts at
 * agent.resume (human decision injected into the re-opened session), then
 * reuses runRepair's exact post-fix pipeline (repairFixed: extractPatch →
 * G3 → MR CI monitor/retry). Single-sourced — no forked G3/monitor logic.
 *
 * One-round intervention: a resume NEVER registers a new decision and is
 * never decidable/retained again — completion is terminal (the worker
 * manager cleans the scene, T05).
 */

import { join as joinPath } from "node:path";
import type { PipelineEvent, RepairOutcome, AgentResult } from "../types.js";
import type { AgentRunInput } from "../agent/runner.js";
import type { WorkerDeps } from "./run-repair.js";
import { repairFixed, parseDiffFiles } from "./run-repair.js";
import { repairBranchName } from "./repair-branch.js";
import { finishRepair, repairCost } from "./repair-outcome.js";
import { emptyTokenUsage } from "../util/cost.js";
import { logger } from "../util/log.js";

/** Decision slice delivered with a resume task (scheduler envelope, T05). */
export interface ResumeContext {
	readonly decisionId: string;
	readonly value: "test" | "widen";
	readonly remark: string;
	/** G3 扩围（ADR-0009）：批准的 MR diff 外文件清单（仅 widen）。 */
	readonly oosPaths?: readonly string[];
}

/** Normalize an unknown error to a message string. */
function errMsg(e: unknown): string {
	return e instanceof Error ? e.message : String(e);
}

/**
 * Run one human-decided resume against the retained scene.
 * Same terminal contract as runRepair (finishRepair for every exit path).
 */
export async function runResumeRepair(
	deps: WorkerDeps,
	event: PipelineEvent,
	resume: ResumeContext,
): Promise<RepairOutcome> {
	const { agent, glab, dingtalk, worktree } = deps;
	const audit = { decisionId: resume.decisionId, chainDepth: 1 };
	logger.info(
		{
			decisionId: resume.decisionId,
			projectId: event.projectId,
			pipelineId: event.pipelineId,
		},
		"resume pipeline start",
	);

	if (!agent.resume) {
		return finishRepair({
			dingtalk,
			cwd: deps.cwd,
			event,
			removeWorktree: worktree.remove,
			audit,
			result: {
				kind: "failed",
				summary: "agent-resume-unsupported",
				error: "runner does not support resume",
			},
		});
	}

	// The retained worktree lives at <cwd>/repo (worktree.create convention —
	// "the agent's working tree at <workDir>/repo"). Resume reuses it as-is;
	// creating a fresh worktree here would discard the agent's prior edits.
	const repoCwd = joinPath(deps.cwd, "repo");
	const agentInput: AgentRunInput = {
		projectId: event.projectId,
		pipelineId: event.pipelineId,
		ref: event.ref,
		sha: event.sha,
		// The re-opened session already carries the original CI log / MR diff.
		ciLog: "",
		mrDiff: "",
		cwd: repoCwd,
		sourceBranch: repairBranchName(event),
		targetBranch: event.mrSourceBranch ?? event.ref,
	};

	const agentStartedAt = Date.now();
	let result: AgentResult;
	try {
		result = await agent.resume(agentInput, {
			value: resume.value,
			remark: resume.remark,
			...(resume.oosPaths?.length ? { oosPaths: resume.oosPaths } : {}),
		});
	} catch (err) {
		return finishRepair({
			dingtalk,
			cwd: deps.cwd,
			event,
			removeWorktree: worktree.remove,
			audit,
			result: { kind: "failed", summary: "agent-resume", error: errMsg(err) },
		});
	}
	const agentTokens = result.metrics?.tokens ?? 0;
	const agentUsage = result.metrics?.usage ?? emptyTokenUsage();
	const agentMetrics = {
		turns: result.metrics?.turns ?? 0,
		tokens: agentTokens,
		usage: agentUsage,
		cost: repairCost(agentUsage),
		durationMs: Date.now() - agentStartedAt,
	} as const;

	if (result.kind === "escalated") {
		// One-round intervention terminal: never decidable again, never retained.
		return finishRepair({
			dingtalk,
			cwd: deps.cwd,
			event,
			removeWorktree: worktree.remove,
			audit,
			result: {
				kind: "escalated",
				summary: result.reason,
				diagnosis: result.diagnosis,
				metrics: agentMetrics,
				model: result.model,
			},
		});
	}

	// fixed → the SAME post-fix pipeline as runRepair (extractPatch → G3 →
	// MR CI monitor/retry → createMR consumed via mrUrl).
	const mrDiff = event.mrIid
		? await glab.fetchMrDiff(event.projectId, event.mrIid)
		: "";
	const diffFilesBase = parseDiffFiles(mrDiff);
	// G3 扩围（ADR-0009）：widen 批准后白名单追加获批的 MR diff 外文件。
	const diffFiles =
		resume.value === "widen" && resume.oosPaths?.length
			? [...new Set([...diffFilesBase, ...resume.oosPaths])]
			: diffFilesBase;
	try {
		return await repairFixed({
			deps,
			event,
			repoCwd,
			result,
			diffFiles,
			agentInput,
			agentMetrics,
			audit,
		});
	} finally {
		agent.close();
	}
}
