/**
 * run-repair — the G2 pipeline orchestration for one event, inside a worker.
 *
 * Sequence:
 *   1. fetch CI log (glab)
 *   1a. class-5 early filter (dependency-resolution screen) — skip agent, save budget
 *   2. create worktree + run agent session (diagnosis → fix → doc sync)
 *   3. on "fixed": extract real git patch → G3 validate → re-run tests → create MR
 *   4. notify DingTalk (success) — bot code, deterministic, agent never holds it
 *   5. on "escalated": notify DingTalk (escalation), no MR
 */

import type { AgentRunner, AgentRunInput } from "../agent/runner.js";
import { parseMrIid } from "../agent/runner.js";
import type { GitLabClient, MrPipelineStatus } from "../gitlab/glab-client.js";
import type { DingTalkNotifier } from "../notify/dingtalk.js";
import type { PipelineEvent, RepairOutcome, Patch, AgentResult, Diagnosis } from "../types.js";
import { logger } from "../util/log.js";
import type { Worktree } from "./worktree.js";
import { repairBranchName } from "./repair-branch.js";
import { finishRepair, repairCost } from "./repair-outcome.js";
import { emptyTokenUsage } from "../util/cost.js";
import { findMrSession } from "./mr-session-store.js";
import { sendIpc } from "../dashboard/ipc-types.js";
import { mkdirSync, copyFileSync } from "node:fs";
import { join as joinPath } from "node:path";

/** Normalize an unknown error to a message string. */
function errMessage(e: unknown): string {
	return e instanceof Error ? e.message : String(e);
}

/** Result of one verification layer (related or full regression). */
export type TestRunStatus = "green" | "flaky" | "fail";

/** A test run outcome. */
export interface TestRunResult {
	readonly status: TestRunStatus;
}

/**
 * Test runner seam — the verification gate is injectable so e2e fixtures
 * can control two-layer verify outcomes without a real Maven/Gradle.
 *
 * Two layers (per ticket 04):
 *   1. runRelated — only the test classes the patch touches (fast feedback)
 *   2. runFull   — full regression (catches breakage elsewhere)
 * Layer 2 runs only if layer 1 is green.
 */
export interface TestRunner {
	runRelated(cwd: string, patch: Patch): Promise<TestRunResult>;
	runFull(cwd: string): Promise<TestRunResult>;
}

export interface WorkerDeps {
	readonly agent: AgentRunner;
	readonly glab: GitLabClient;
	readonly dingtalk: DingTalkNotifier;
	readonly cwd: string;
	/** Worktree seam (create + best-effort remove). Injected so runRepair is unit-testable without real git. */
	readonly worktree: Worktree;
	/** Optional test runner for two-layer verification. Defaults to mvn/gradle. */
	readonly verifyRunner?: TestRunner;
}

/**
 * True when an agent result is a decidable escalation: the agent itself
 * chose to escalate (source "agent") and attached a diagnosis. Only such
 * escalations may enter the awaiting-decision state (scene retention +
 * /heal). Runner-generated escalations (budget exceeded / session error /
 * unparseable output) stay pure handoffs.
 *
 * Class-5 diagnoses are excluded regardless of source: compile/dependency
 * failures leave no decision to make (/heal only resolves diagnosis
 * uncertainty), so no scene is retained — same shape as the bot's own
 * early-filter escalations.
 */
export function isDecidableEscalation(result: AgentResult): boolean {
	return (
		result.kind === "escalated" &&
		result.source === "agent" &&
		Boolean(result.diagnosis) &&
		result.diagnosis.failureClass !== 5
	);
}

export async function runRepair(
	deps: WorkerDeps,
	event: PipelineEvent,
): Promise<RepairOutcome> {
	const { agent, glab, dingtalk, worktree } = deps;
	log("start", event);
	sendIpc({ type: "stage_enter", stage: "fetch-ci-log", pipelineId: event.pipelineId, projectId: event.projectId });

	// 1. Fetch CI log. (MR diff fetched only if a related MR exists; tracer
	//    bullet has none, so we pass empty.)
	let ciLog: string;
	try {
		ciLog = await glab.fetchCiLog(event.projectId, event.pipelineId);
	} catch (err) {
		return finishRepair({
			dingtalk,
			cwd: deps.cwd,
			event,
			removeWorktree: worktree.remove,
			result: {
				kind: "failed",
				summary: "fetch-ci-log",
				error: errMessage(err),
			},
		});
	}

	sendIpc({ type: "stage_exit", stage: "fetch-ci-log" });
	sendIpc({ type: "stage_enter", stage: "early-filter", pipelineId: event.pipelineId, projectId: event.projectId });

	// 1a. Class-5 early filter: scan CI log for dependency-resolution errors
	//     BEFORE spawning the agent. Pure bot code (deterministic), saving
	//     budget on failures whose outcome is a foregone conclusion. Compile
	//     errors pass through — class 2 vs 5 attribution is the agent's call.
	const class5Reason = detectClass5(ciLog);
	if (class5Reason) {
		const reason = `class 5 非单测失败：${class5Reason}，转交人工（不起 agent）`;
		return finishRepair({
			dingtalk,
			cwd: deps.cwd,
			event,
			removeWorktree: worktree.remove,
			result: { kind: "escalated", summary: reason },
		});
	}

	// 1b. Create a worktree from the project's shared bare clone (G2 local
	//     clone). The worktree is the agent's real working tree — it sees the
	//     repo at the pipeline's sha, edits files here, runs tests here. The
	//     CI log / MR diff spill files stay in deps.cwd (outside the worktree)
	//     so they never pollute the repo's git diff.
	let repoCwd: string;
	try {
		repoCwd = await worktree.create(deps.cwd, event);
	} catch (err) {
		return finishRepair({
			dingtalk,
			cwd: deps.cwd,
			event,
			removeWorktree: worktree.remove,
			result: { kind: "failed", summary: "worktree", error: errMessage(err) },
		});
	}

	sendIpc({ type: "stage_exit", stage: "early-filter" });
	sendIpc({ type: "stage_enter", stage: "agent-run", pipelineId: event.pipelineId, projectId: event.projectId });

	// 2. Run the agent session (diagnosis → fix → doc sync).
	//    The agent self-executes: edits files + runs tests via bash inside the
	//    session, all within the worktree (repoCwd). It returns a structured
	//    result, NOT file contents.
	const agentStartedAt = Date.now();
	const sourceBranch = repairBranchName(event);
	// MR-triggered pipelines: target the MR's real source_branch (e.g.
	// guild-policy-outreach) so merging the fix MR updates the source MR's CI.
	// Push pipelines: target the pipeline's ref directly.
	const targetBranch = event.mrSourceBranch ?? event.ref;
	// Fetch the MR diff so the agent can scope edits to the diff file set and
	// the bot can whitelist-validate the resulting patch (G0 diff gate).
	const mrDiff = event.mrIid
		? await glab.fetchMrDiff(event.projectId, event.mrIid)
		: "";
	const diffFiles = parseDiffFiles(mrDiff);

	// ADR-0007：跨 pipeline session 复用——同 MR 有上次修复存档则拷入本 worker
	//（store 保持只读，终局 latest-wins 重新存档）；runner open + compact + continue。
	// 未命中/拷贝失败降级为全新 session。
	let reuseSessionFile: string | undefined;
	let reuseMeta: { pipelineId: number; sha: string } | undefined;
	const stored = findMrSession(event);
	if (stored) {
		try {
			const reuseDir = joinPath(deps.cwd, ".pi-agent", "sessions", "reuse");
			mkdirSync(reuseDir, { recursive: true });
			reuseSessionFile = joinPath(reuseDir, `reuse-${event.pipelineId}.jsonl`);
			copyFileSync(stored.sessionPath, reuseSessionFile);
			reuseMeta = { pipelineId: stored.meta.pipelineId, sha: stored.meta.sha };
			logger.info(
				{ fromPipeline: stored.meta.pipelineId, reuseSessionFile },
				"reusing archived MR session (open + compact + continue)",
			);
		} catch (err) {
			reuseSessionFile = undefined;
			reuseMeta = undefined;
			logger.warn(
				{ err: errMessage(err) },
				"reuse session copy failed — falling back to fresh session",
			);
		}
	}

	const agentInput: AgentRunInput = {
		projectId: event.projectId,
		pipelineId: event.pipelineId,
		ref: event.ref,
		sha: event.sha,
		ciLog,
		mrDiff,
		cwd: repoCwd,
		sourceBranch,
		targetBranch,
		failedStages: event.failedStages,
		...(reuseSessionFile ? { reuseSessionFile, reuseMeta } : {}),
	};
	let result;
	try {
		result = await agent.run(agentInput);
	} catch (err) {
		// close → dispose 存档 session（best-effort）；异常路径不得泄漏 session
		agent.close();
		return finishRepair({
			dingtalk,
			cwd: deps.cwd,
			event,
			removeWorktree: worktree.remove,
			result: { kind: "failed", summary: "agent-run", error: errMessage(err) },
		});
	}
	// Ticket 07: per-fix metrics from the agent session (turns/tokens) +
	// wall-clock duration. Failed paths go through finishRepair without these
	// (no result.metrics to read), which writes a zero-metrics trace.
	const agentTokens = result.metrics?.tokens ?? 0;
	const agentTurns = result.metrics?.turns ?? 0;
	const agentUsage = result.metrics?.usage ?? emptyTokenUsage();
	const agentMetrics = {
		turns: agentTurns,
		tokens: agentTokens,
		usage: agentUsage,
		cost: repairCost(agentUsage),
		durationMs: Date.now() - agentStartedAt,
	} as const;

	sendIpc({ type: "stage_exit", stage: "agent-run" });

	// 3. Branch on the structured agent result.
	if (result.kind === "escalated") {
		// Scene retention (T03): only an agent-initiated escalation with a
		// diagnosis is decidable — finishRepair then skips the worktree cleanup
		// and flags the outcome so the main process registers a decision.
		const decidable = isDecidableEscalation(result);
		// close → dispose 存档 agent-session.jsonl 到审计目录（MR !281 run 6
		// 缺口：escalated 不 close 导致现场清理后 session 遥测全失）
		agent.close();
		// 现场改动快照（入审计）：非可决策转交会清理现场，不能丢失改动记录
		const sceneChanges = await snapshotSceneChanges(repoCwd);
		return finishRepair({
			dingtalk,
			cwd: deps.cwd,
			event,
			removeWorktree: worktree.remove,
			...(reuseMeta
				? { audit: { reusedFromPipeline: reuseMeta.pipelineId } }
				: {}),
			result: {
				kind: "escalated",
				summary: result.reason,
				diagnosis: result.diagnosis,
				metrics: agentMetrics,
				model: result.model,
				...(decidable ? { decidable: true } : {}),
				...(result.mrUrl ? { mrUrl: result.mrUrl } : {}),
				...(sceneChanges.length ? { sceneChanges } : {}),
			},
		});
	}

	// 4. result.kind === "fixed" — extract the authoritative patch, validate it
	//    against the MR diff whitelist, then monitor the MR's CI and retry by
	//    reusing the agent session if CI stays red. The CI re-run is the
	//    verification gate (it re-checks the exact failing stage), so no
	//    separate test runner is needed.
	let outcome: RepairOutcome;
	try {
		outcome = await repairFixed({
			deps,
			event,
			repoCwd,
			result,
			diffFiles,
			mrDiff: agentInput.mrDiff,
			agentInput,
			agentMetrics,
			...(reuseMeta
				? { audit: { reusedFromPipeline: reuseMeta.pipelineId } }
				: {}),
		});
	} finally {
		agent.close();
	}
	return outcome;
}

/**
 * Best-effort 快照：agent 在 worktree 里改动的文件清单（git status --porcelain，
 * 排除 spill 文件）。escalated 终局入审计用；任何错误返回空数组，绝不阻断
 * 转交流程。
 */
export async function snapshotSceneChanges(repoCwd: string): Promise<string[]> {
	try {
		const { execFile } = await import("node:child_process");
		const { promisify } = await import("node:util");
		const exec = promisify(execFile);
		const { stdout } = await exec("git", ["status", "--porcelain"], {
			cwd: repoCwd,
			maxBuffer: EXEC_MAX_BUFFER,
		});
		return stdout
			.split("\n")
			.filter((line) => line.length > 3)
			.map((line) => line.slice(3).trim())
			.filter((path) => !isPatchNoise(path));
	} catch {
		return [];
	}
}

/**
 * Post-"fixed" pipeline: extract the real patch, whitelist-validate it, then
 * monitor the MR's CI. If CI stays red, reuse the agent's open session to
 * continue fixing (updating the same MR), up to CIHEAL_RETRY_LIMIT times.
 */
export async function repairFixed(args: {
	deps: WorkerDeps;
	event: PipelineEvent;
	repoCwd: string;
	result: Extract<AgentResult, { kind: "fixed" }>;
	diffFiles: readonly string[];
	mrDiff?: string;
	agentInput: AgentRunInput;
	agentMetrics: { turns: number; tokens: number; cost: number; durationMs: number };
	/** T06: resume-run audit context (decision chain) threaded into every trace. */
	audit?: { readonly decisionId?: string; readonly chainDepth?: number; readonly reusedFromPipeline?: number };
}): Promise<RepairOutcome> {
	const { deps, event, repoCwd, result, diffFiles, mrDiff, agentInput, audit } = args;
	const { glab, dingtalk, worktree } = deps;

	const patch = await extractPatch(repoCwd, result.summary, event.sha);
	if (patch.paths.length === 0) {
		return finishRepair({
			dingtalk,
			cwd: deps.cwd,
			event,
			removeWorktree: worktree.remove,
			audit,
			result: {
				kind: "escalated",
				summary: "empty patch after agent reported fixed",
				diagnosis: result.diagnosis,
				diff: patch.diff,
				metrics: args.agentMetrics,
				model: result.model,
			},
		});
	}
	const g3 = validatePatchPaths(patch, diffFiles);
	if (g3) {
		// G3 扩围（ADR-0009）：违规全为 MR diff 外的测试/文档文件时可决策——
		// 冻干现场 + 注册决策（携带文件清单），人工 /heal <id> widen 批准后续修；
		// 混入 src/main 或 build 配置仍为死路（铁律不变）。
		const oosPaths = widenableG3Paths(patch, diffFiles);
		return finishRepair({
			dingtalk,
			cwd: deps.cwd,
			event,
			removeWorktree: worktree.remove,
			audit,
			result: {
				kind: "escalated",
				summary: `G3/diff 违规：${g3}`,
				diagnosis: result.diagnosis,
				diff: patch.diff,
				metrics: args.agentMetrics,
				model: result.model,
				...(oosPaths ? { decidable: true, oosPaths } : {}),
			},
		});
	}
	const lineScope = validateStaticAnalysisLineScope(
		patch,
		mrDiff ?? agentInput.mrDiff,
		event.failedStages,
	);
	if (lineScope) {
		return finishRepair({
			dingtalk,
			cwd: deps.cwd,
			event,
			removeWorktree: worktree.remove,
			audit,
			result: {
				kind: "escalated",
				summary: `G3/line-scope 违规：${lineScope}`,
				diagnosis: result.diagnosis,
				diff: patch.diff,
				metrics: args.agentMetrics,
				model: result.model,
			},
		});
	}
	// Ticket 07: terminal freshness gate — work baseline must still match MR
	// source branch HEAD before we accept an MR outcome. Escalated paths never
	// reach here; non-MR events skip (backward compatible).
	if (event.mrIid != null && event.mrSourceBranch) {
		try {
			const currentHead = await glab.fetchBranchHeadSha(
				event.projectId,
				event.mrSourceBranch,
			);
			if (currentHead !== event.sha) {
				logger.info(
					{
						projectId: event.projectId,
						pipelineId: event.pipelineId,
						baseline: event.sha,
						currentHead,
						mrSourceBranch: event.mrSourceBranch,
					},
					"freshness gate: baseline superseded, discarding repair",
				);
				return finishRepair({
					dingtalk,
					cwd: deps.cwd,
					event,
					removeWorktree: worktree.remove,
					audit,
					result: {
						kind: "failed",
						summary: "修复基线已被新提交取代，丢弃成果",
						error: "baseline_superseded",
						diagnosis: result.diagnosis,
						diff: patch.diff,
						metrics: args.agentMetrics,
						model: result.model,
					},
				});
			}
		} catch (err) {
			logger.warn(
				{
					err: errMessage(err),
					projectId: event.projectId,
					mrSourceBranch: event.mrSourceBranch,
				},
				"freshness gate: fetchBranchHeadSha failed — degrading to pass-through",
			);
		}
	}
	// 两层测试验证（verifyTwoLayer）v1 仍禁用：MR-CI 重跑即为 re-verify；
	// 其 Mvn/Gradle 硬编码对非 Java 项目误杀，故靠 CI 重跑兜底。
	void verifyTwoLayer;
	// Ticket 08: resolve repair MR — GitLab 为事实源，open → push 更新；
	// closed → 新开并注明；merged / 不存在 → 正常新开。
	let mrUrl: string;
	let mrReopenedNote: string | undefined;
	try {
		const resolved = await resolveRepairMr({
			deps,
			event,
			repoCwd,
			patch,
			diagnosis: result.diagnosis,
		});
		if (!resolved.ok) {
			return finishRepair({
				dingtalk,
				cwd: deps.cwd,
				event,
				removeWorktree: worktree.remove,
				audit,
				result: {
					kind: "escalated",
					summary: resolved.summary,
					diagnosis: result.diagnosis,
					diff: patch.diff,
					metrics: args.agentMetrics,
					model: result.model,
				},
			});
		}
		mrUrl = resolved.mrUrl;
		mrReopenedNote = resolved.reopenedNote;
	} catch (err) {
		return finishRepair({
			dingtalk,
			cwd: deps.cwd,
			event,
			removeWorktree: worktree.remove,
			audit,
			result: {
				kind: "failed",
				summary: "repair-mr",
				error: errMessage(err),
				diagnosis: result.diagnosis,
				diff: patch.diff,
				metrics: args.agentMetrics,
				model: result.model,
			},
		});
	}

	// Monitor the MR's CI + retry by reusing the agent session.
	const mrIid = parseMrIid(mrUrl);
	let currentResult = result;
	let currentPatch = patch;
	let lastStatus: MrPipelineStatus["status"] | "unmonitored" =
		mrIid == null ? "unmonitored" : "pending";
	const maxRetries = readIntEnv("CIHEAL_RETRY_LIMIT", 2);
	const pollIntervalMs = readIntEnv("CIHEAL_POLL_INTERVAL_MS", 10_000);
	const maxPolls = readIntEnv("CIHEAL_POLL_LIMIT", 30);
	let attempt = 0;
	let polls = 0;
	if (mrIid != null) {
		while (attempt < maxRetries) {
			const st = await glab.fetchMrPipelineStatus(event.projectId, mrIid);
			lastStatus = st.status;
			if (st.status === "success" || st.status === "unknown") break;
			if (st.status === "pending") {
				if (polls++ >= maxPolls) break;
				await sleep(pollIntervalMs);
				continue;
			}
			// failed: reuse the agent session to continue fixing the same MR.
			if (st.pipelineId == null) break;
			const newCiLog = await glab.fetchCiLog(event.projectId, st.pipelineId);
			const cont = await deps.agent.continue(
				agentInput,
				mrUrl,
				newCiLog,
			);
			if (cont.kind === "escalated") {
				return finishRepair({
					dingtalk,
					cwd: deps.cwd,
					event,
					removeWorktree: worktree.remove,
					audit,
					result: {
						kind: "escalated",
						summary: cont.reason,
						diagnosis: cont.diagnosis,
						diff: currentPatch.diff,
						mrUrl: cont.mrUrl ?? mrUrl,
						metrics: args.agentMetrics,
						model: result.model,
					},
				});
			}
			const p2 = await extractPatch(repoCwd, cont.summary, event.sha);
			const g3b = validatePatchPaths(p2, diffFiles);
			const lineScopeB = validateStaticAnalysisLineScope(
				p2,
				mrDiff ?? agentInput.mrDiff,
				event.failedStages,
			);
			if (p2.paths.length === 0 || g3b || lineScopeB) {
				return finishRepair({
					dingtalk,
					cwd: deps.cwd,
					event,
					removeWorktree: worktree.remove,
					audit,
					result: {
						kind: "escalated",
						summary:
							p2.paths.length === 0
								? "retry produced empty patch"
								: g3b
									? `retry G3/diff 违规：${g3b}`
									: `retry G3/line-scope 违规：${lineScopeB}`,
						diagnosis: cont.diagnosis,
						diff: p2.diff,
						mrUrl: cont.mrUrl ?? mrUrl,
						metrics: args.agentMetrics,
						model: result.model,
					},
				});
			}
			currentResult = cont;
			currentPatch = p2;
			attempt++;
		}
	}

	if (mrIid == null || lastStatus === "success" || lastStatus === "unknown") {
		return finishRepair({
			dingtalk,
			cwd: deps.cwd,
			event,
			removeWorktree: worktree.remove,
			audit,
			result: {
				kind: "mr",
				summary: currentResult.diagnosis.summary,
				diagnosis: currentResult.diagnosis,
				diff: currentPatch.diff,
				mrUrl,
				metrics: args.agentMetrics,
				model: result.model,
				...(mrReopenedNote ? { mrReopenedNote } : {}),
			},
		});
	}
	return finishRepair({
		dingtalk,
		cwd: deps.cwd,
		event,
		removeWorktree: worktree.remove,
		audit,
		result: {
			kind: "escalated",
		summary: `MR CI 仍红，重试 ${attempt} 次后转交人工`,
		diagnosis: currentResult.diagnosis,
		diff: currentPatch.diff,
		mrUrl,
		metrics: args.agentMetrics,
		model: result.model,
		},
	});
}

/** Ticket 08: GitLab 为事实源，决定原地更新还是新开修复 MR。 */
export async function resolveRepairMr(args: {
	deps: WorkerDeps;
	event: PipelineEvent;
	repoCwd: string;
	patch: Patch;
	diagnosis: Diagnosis;
}): Promise<
	| { readonly ok: true; readonly mrUrl: string; readonly reopenedNote?: string }
	| { readonly ok: false; readonly summary: string }
> {
	const { deps, event, repoCwd, patch, diagnosis } = args;
	const { glab, worktree } = deps;
	const repairBranch = repairBranchName(event);
	const targetBranch = event.mrSourceBranch ?? event.ref;
	const existingMr = await glab.findMrBySourceBranch(event.projectId, repairBranch);

	await worktree.pushBranch(repoCwd, repairBranch);

	if (existingMr?.status === "opened") {
		if (!existingMr.url) {
			return { ok: false, summary: "open repair MR missing web_url" };
		}
		return { ok: true, mrUrl: existingMr.url };
	}

	let descriptionPrefix: string | undefined;
	let reopenedNote: string | undefined;
	if (existingMr?.status === "closed") {
		descriptionPrefix = `> 上一个修复 MR !${existingMr.iid} 被关闭，本次为新尝试。\n\n`;
		reopenedNote = `上一个修复 MR !${existingMr.iid} 被关闭，本次为新尝试。`;
	}

	const created = await glab.createMr({
		projectId: event.projectId,
		sourceBranch: repairBranch,
		targetBranch,
		title: `fix(ci): ${diagnosis.summary.slice(0, 80)}`,
		diagnosis,
		patch,
		...(descriptionPrefix ? { descriptionPrefix } : {}),
	});
	if (!created.url) {
		return { ok: false, summary: "createMr returned empty url" };
	}
	return { ok: true, mrUrl: created.url, ...(reopenedNote ? { reopenedNote } : {}) };
}

/** Spill files (CI log / MR diff / diff index) the bot writes into the
 *  worktree — must never appear in the extracted patch. */
const SPILL_RE =
	/(^|\/)(ci-log.*\.txt|mr-diff\.patch|mr-diff-index\.txt)$/;

/** 构建工具状态（Maven 本地仓库）：agent 在 worktree 内跑 mvn 可能写出
 *  仓库内 .m2（MR !281 e2e：.lastUpdated 混入 patch 触发 G3 误杀）。
 *  构建态永远不是修复产物。 */
const BUILD_NOISE_RE = /(^|\/)\.m2\//;

/** patch 提取排除的非修复噪声（bot spill 文件 + 构建工具状态）。 */
export function isPatchNoise(path: string): boolean {
	return SPILL_RE.test(path) || BUILD_NOISE_RE.test(path);
}

/** Whitelist-validate a patch (G0 diff gate): every path must be in the MR
 *  diff file set (or, with no diff context, a non-production test/doc path).
 *  Build/CI config is always forbidden. */
function validatePatchPaths(patch: Patch, diffFiles: readonly string[]): string | null {
	for (const p of patch.paths) {
		if (isForbiddenConfig(p)) return `patch touches build/CI config: ${p}`;
		if (diffFiles.length === 0) {
			if (isProductionPath(p)) {
				return `patch touches production code with no diff context: ${p}`;
			}
		} else if (!diffFiles.includes(p)) {
			return `patch touches file outside MR diff: ${p}`;
		}
	}
	return null;
}

/** patch 中 MR diff 外的文件清单（G3 扩围决策上下文）；无 diff 上下文时为空。 */
export function outsideDiffPaths(
	patch: Patch,
	diffFiles: readonly string[],
): string[] {
	if (diffFiles.length === 0) return [];
	return patch.paths.filter((p) => !diffFiles.includes(p));
}

/** 可扩围路径（ADR-0009）：含 src/test|it 段，或文档文件。
 *  刻意比 !isProductionPath 严格：多模块仓库的 `svc/src/main/...` 前缀规则
 *  无法可靠判为生产路径（^src/main 锚定路径开头），扩围是授权边界，必须保守。 */
export function isWidenEligiblePath(p: string): boolean {
	const norm = p.replace(/\\/g, "/");
	if (/(^|\/)src\/(test|it)\//.test(norm)) return true;
	if (/(^|\/)docs?\//.test(norm)) return true;
	return /\.(md|adoc|rst)$/.test(norm);
}

/** G3 违规可扩围判定（ADR-0009）：patch 不碰 build/CI 配置，且 diff 外文件
 *  全为测试/文档（isWidenEligiblePath）时返回该清单；否则 null（死路转交，铁律不变）。 */
export function widenableG3Paths(
	patch: Patch,
	diffFiles: readonly string[],
): readonly string[] | null {
	if (patch.paths.some(isForbiddenConfig)) return null;
	const oos = outsideDiffPaths(patch, diffFiles);
	if (oos.length === 0 || !oos.every(isWidenEligiblePath)) return null;
	return oos;
}

/** Parse the changed file set from an MR diff text. Supports both the
 * `diff --git a/x b/y` headers and the plain unified `--- x` / `+++ y`
 * pairs glab emits (the real MR !281 diff had zero `diff --git` lines —
 * the old parser returned an empty file set, silently disabling G0). */
export function parseDiffFiles(diff: string): string[] {
	const files: string[] = [];
	let minusPath: string | null = null;
	for (const line of diff.split("\n")) {
		const gitHeader = line.match(/^diff --git a\/(.+?) b\/(.+?)\s*$/);
		if (gitHeader) {
			files.push(gitHeader[2]);
			minusPath = null;
			continue;
		}
		const minus = line.match(/^--- (.+?)\s*$/);
		if (minus) {
			minusPath = minus[1] === "/dev/null" ? null : minus[1];
			continue;
		}
		const plus = line.match(/^\+\+\+ (.+?)\s*$/);
		if (plus && plus[1] !== "/dev/null") {
			let path = plus[1];
			// Strip a/ b/ prefixes only when both sides carry them symmetrically.
			if (
				minusPath != null &&
				path.startsWith("b/") &&
				minusPath.startsWith("a/") &&
				minusPath.slice(2) === path.slice(2)
			) {
				path = path.slice(2);
			}
			files.push(path);
			minusPath = null;
		}
	}
	return [...new Set(files)];
}

/** Parse unified-diff hunk headers and return new-side line ranges per file. */
export function parseDiffHunkRanges(
	diff: string,
): Map<string, Array<[number, number]>> {
	const result = new Map<string, Array<[number, number]>>();
	let curPath: string | null = null;
	let minusPath: string | null = null;
	let minusDevNull = false;

	const addRange = (path: string, start: number, count: number) => {
		if (count <= 0) return;
		const end = start + count - 1;
		const ranges = result.get(path) ?? [];
		ranges.push([start, end]);
		result.set(path, ranges);
	};

	for (const line of diff.split("\n")) {
		const gitHeader = line.match(/^diff --git a\/(.+?) b\/(.+?)\s*$/);
		if (gitHeader) {
			curPath = gitHeader[2];
			minusPath = null;
			minusDevNull = false;
			continue;
		}
		const minus = line.match(/^--- (.+?)\s*$/);
		if (minus) {
			minusDevNull = minus[1] === "/dev/null";
			minusPath = minusDevNull ? null : minus[1];
			continue;
		}
		const plus = line.match(/^\+\+\+ (.+?)\s*$/);
		if (plus) {
			if (plus[1] === "/dev/null") {
				curPath = minusPath;
			} else {
				let path = plus[1];
				if (
					minusPath != null &&
					path.startsWith("b/") &&
					minusPath.startsWith("a/") &&
					minusPath.slice(2) === path.slice(2)
				) {
					path = path.slice(2);
				} else if (minusDevNull && path.startsWith("b/")) {
					path = path.slice(2);
				}
				curPath = path;
			}
			continue;
		}
		const hunk = line.match(/^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/);
		if (hunk && curPath) {
			const newStart = Number.parseInt(hunk[3], 10);
			const newCount =
				hunk[4] != null ? Number.parseInt(hunk[4], 10) : 1;
			addRange(curPath, newStart, newCount);
		}
	}
	return result;
}

/** True when failedStages includes static-analysis-related stage names. */
export function isStaticAnalysisStage(
	stages: readonly string[] | undefined,
): boolean {
	if (!stages || stages.length === 0) return false;
	return stages.some((stage) => {
		const lower = stage.toLowerCase();
		if (lower === "lint") return true;
		if (lower.includes("checkstyle")) return true;
		if (lower.includes("spotbugs")) return true;
		if (lower.includes("static-analysis") || lower.includes("static_analysis")) {
			return true;
		}
		if (lower.includes("pmd")) return true;
		return false;
	});
}

/** ±N lines tolerance for line-scope G3 validation. */
export const HUNK_SCOPE_TOLERANCE = 5;

/** Line-scope G3: production paths in patch must overlap MR diff hunks (± tolerance). */
export function validatePatchLineScope(
	patchDiff: string,
	mrHunks: Map<string, Array<[number, number]>>,
	tolerance = HUNK_SCOPE_TOLERANCE,
): string | null {
	const agentHunks = parseDiffHunkRanges(patchDiff);
	for (const [file, ranges] of agentHunks) {
		if (!isProductionPath(file)) continue;
		const mrRanges = mrHunks.get(file);
		if (!mrRanges || mrRanges.length === 0) {
			return `patch modifies ${file} outside MR diff line scope`;
		}
		for (const [a, b] of ranges) {
			const inScope = mrRanges.some(
				([c, d]) => a <= d + tolerance && b >= c - tolerance,
			);
			if (!inScope) {
				return `patch modifies ${file}:${a}-${b} outside MR diff line scope`;
			}
		}
	}
	return null;
}

function validateStaticAnalysisLineScope(
	patch: Patch,
	mrDiff: string | undefined,
	failedStages: readonly string[] | undefined,
): string | null {
	if (!isStaticAnalysisStage(failedStages)) return null;
	const mrHunks = parseDiffHunkRanges(mrDiff ?? "");
	return validatePatchLineScope(patch.diff, mrHunks);
}

/**
 * Build a compact per-file index of an MR diff (path + added/removed line
 * counts). Written next to mr-diff.patch so the agent orients on the change
 * set from a ~1KB index instead of scanning a multi-MB patch (MR !281 perf).
 * Supports both `diff --git` headers and the plain unified `---/+++` pairs
 * glab emits. Returns "" when no files are found — callers then skip the
 * index file.
 */
export function buildDiffIndex(diff: string): string {
	interface Entry {
		path: string;
		adds: number;
		dels: number;
		added: boolean;
		deleted: boolean;
	}
	const entries: Entry[] = [];
	let cur: Entry | null = null;
	let minusDevNull = false;
	let minusPath: string | null = null;
	for (const line of diff.split("\n")) {
		const gitHeader = line.match(/^diff --git a\/(.+?) b\/(.+?)\s*$/);
		if (gitHeader) {
			cur = { path: gitHeader[2], adds: 0, dels: 0, added: false, deleted: false };
			entries.push(cur);
			minusDevNull = false;
			minusPath = null;
			continue;
		}
		const minus = line.match(/^--- (.+?)\s*$/);
		if (minus) {
			minusDevNull = minus[1] === "/dev/null";
			minusPath = minusDevNull ? null : minus[1];
			continue;
		}
		const plus = line.match(/^\+\+\+ (.+?)\s*$/);
		if (plus) {
			if (plus[1] === "/dev/null") {
				// Pure deletion — the file named by the preceding --- line.
				if (minusPath != null) {
					cur = { path: minusPath, adds: 0, dels: 0, added: false, deleted: true };
					entries.push(cur);
				} else {
					cur = null;
				}
			} else {
				let path = plus[1];
				// Strip a/ b/ prefixes when symmetric, or b/ on a new file.
				if (
					minusPath != null &&
					path.startsWith("b/") &&
					minusPath.startsWith("a/") &&
					minusPath.slice(2) === path.slice(2)
				) {
					path = path.slice(2);
				} else if (minusDevNull && path.startsWith("b/")) {
					path = path.slice(2);
				}
				cur = { path, adds: 0, dels: 0, added: minusDevNull, deleted: false };
				entries.push(cur);
			}
			continue;
		}
		if (!cur) continue;
		if (line.startsWith("+")) cur.adds++;
		else if (line.startsWith("-")) cur.dels++;
	}
	if (entries.length === 0) return "";
	const lines = [`MR diff 文件索引（${entries.length} 个文件）：`];
	for (const e of entries) {
		const tag = e.added ? "（新增）" : e.deleted ? "（删除）" : "";
		lines.push(`${e.path}  +${e.adds} -${e.dels}${tag}`);
	}
	return lines.join("\n");
}

/** Build/CI config files are never editable, even inside the MR diff. */
function isForbiddenConfig(p: string): boolean {
	return /(^|\/)(pom\.xml|build\.gradle|build\.gradle\.kts|settings\.gradle|settings\.gradle\.kts|Dockerfile|\.gitlab-ci\.yml)$/.test(
		p,
	);
}

/** Drop spill-file hunks from a unified diff so they never enter the patch. */
function stripSpillDiff(diff: string): string {
	return diff
		.split(/\n(?=diff --git )/)
		.filter((hunk) => {
			const m = hunk.match(/^diff --git a\/(.+?) b\/(.+?)\s*$/m);
			const path = m ? m[2] : "";
			return !isPatchNoise(path);
		})
		.join("\n");
}

function sleep(ms: number): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, ms));
}

function readIntEnv(name: string, fallback: number): number {
	const v = Number(process.env[name]);
	return Number.isFinite(v) && v > 0 ? v : fallback;
}

function shortSha(sha: string): string {
	return sha.slice(0, 8);
}

/**
 * Stdout buffer ceiling for subprocess calls. Node's execFile default
 * (1MB) is too small: a git diff that includes large MR spill files, or a
 * multi-module mvn test run, exceeds it easily — the default crashed the
 * worker with RangeError on MR !281 pipeline 100033426's extractPatch run.
 */
const EXEC_MAX_BUFFER = 128 * 1024 * 1024;

/**
 * Extract the real git patch from the agent's worktree.
 * `git diff <baseSha>` is authoritative — captures all agent changes
 * (committed or not) relative to the pipeline's sha. Agent self-reported
 * content is never trusted.
 */
export async function extractPatch(
	cwd: string,
	summary: string,
	baseSha: string,
): Promise<Patch> {
	const { execFile } = await import("node:child_process");
	const { promisify } = await import("node:util");
	const exec = promisify(execFile);
	// Stage agent's edits so untracked new files appear in the diff (baseSha
	// has no record of them). Bot spill files (ci-log/mr-diff/diff-index) and
	// build-tool state (.m2) may live inside repoCwd — isPatchNoise drops them.
	await exec("git", ["add", "-A"], { cwd });
	const { stdout: rawDiff } = await exec(
		"git",
		["diff", "--no-color", baseSha],
		{ cwd, maxBuffer: EXEC_MAX_BUFFER },
	);
	const { stdout: namesOut } = await exec(
		"git",
		["diff", "--name-only", baseSha],
		{ cwd, maxBuffer: EXEC_MAX_BUFFER },
	);
	const paths = namesOut
		.split("\n")
		.map((s) => s.trim())
		.filter(Boolean)
		.filter((p) => !isPatchNoise(p));
	const diff = stripSpillDiff(rawDiff);
	return { diff, paths, summary };
}

/**
 * Two-layer verification (ticket 04): related tests first, then full
 * regression. Flaky in layer 2 → bot scans the staged diff for @Skip/@Disabled
 * annotations the agent added and reverts those files (git diff is
 * authoritative — we don't trust runner-reported test paths), then sends
 * an independent flaky DingTalk. Repair proceeds (flaky doesn't block).
 *
 * Returns "green" (both pass, or full-regression flaky handled), "fail"
 * (genuine breakage), or "flaky-related" (layer 1 flaky — the fix itself is
 * unstable, must escalate: don't @Skip the very tests we're fixing).
 */
async function verifyTwoLayer(
	cwd: string,
	patch: Patch,
	runner: TestRunner | undefined,
	dingtalk: DingTalkNotifier,
	event: PipelineEvent,
): Promise<TestRunStatus> {
	const r = runner ?? new MvnGradleTestRunner();

	// Layer 1: related tests only (fast feedback on the fix).
	const related = await r.runRelated(cwd, patch);
	if (related.status === "fail") return "fail";
	if (related.status === "flaky") {
		// Related-test flaky means the fix itself is unstable — escalate,
		// don't @Skip the very tests we're trying to fix.
		return "flaky";
	}

	// Layer 2: full regression (catches breakage elsewhere in the suite).
	const full = await r.runFull(cwd);
	if (full.status === "green") return "green";
	if (full.status === "fail") return "fail";

	// Flaky in full regression: the agent has already marked @Skip/@Disabled
	// on the flaky tests (per skill). Bot scans the staged diff for those
	// annotations and reverts the files (per design: no @Skip in repair MR),
	// then sends an independent flaky DingTalk so humans can decide.
	const skippedFiles = await findSkipAnnotations(cwd);
	await discardSkipEdits(cwd, skippedFiles);
	await notifyFlaky(dingtalk, event, skippedFiles);
	return "green";
}

/**
 * Scan the staged diff for @Skip/@Disabled annotations the agent added on
 * test files. Returns the repo-relative paths of files whose staged diff
 * adds a @Skip/@Disabled annotation.
 *
 * This is the git-diff-authoritative approach to flaky handling: we don't
 * trust the runner to report flaky test paths (fragile parsing), we inspect
 * what the agent actually wrote.
 */
async function findSkipAnnotations(cwd: string): Promise<string[]> {
	const { execFile } = await import("node:child_process");
	const { promisify } = await import("node:util");
	const exec = promisify(execFile);
	try {
		const { stdout: namesOut } = await exec(
			"git",
			["diff", "--name-only", "--cached"],
			{ cwd, maxBuffer: EXEC_MAX_BUFFER },
		);
		const paths = namesOut
			.split("\n")
			.map((s) => s.trim())
			.filter(Boolean)
			.filter((p) => TEST_PATH_RE.test(p));
		const skipped: string[] = [];
		for (const p of paths) {
			const { stdout: diff } = await exec(
				"git",
				["diff", "--no-color", "--cached", "--", p],
				{ cwd, maxBuffer: EXEC_MAX_BUFFER },
			);
			// Added lines (diff hunk lines starting with '+') that contain a
			// @Skip or @Disabled annotation.
			if (/^\+.*@(?:Skip|Disabled)\b/m.test(diff)) {
				skipped.push(p);
			}
		}
		return skipped;
	} catch (err) {
		logger.warn({ err }, "find-skip-annotations failed");
		return [];
	}
}

/** Send an independent flaky DingTalk notification (decoupled from repair MR). */
function notifyFlaky(
	dingtalk: DingTalkNotifier,
	event: PipelineEvent,
	skippedFiles: readonly string[],
): Promise<void> {
	const list =
		skippedFiles.length > 0 ? skippedFiles.join(", ") : "(未扫描到 @Skip 改动)";
	return dingtalk.send({
		title: "CI 自愈遇 flaky",
		text: [
			`项目 ${event.projectId}`,
			`分支 ${event.ref} @ ${shortSha(event.sha)}`,
			`全量回归遇 flaky，agent 已标 @Skip/@Disabled 于：${list}`,
			`已丢弃 @Skip 改动，修复 MR 不含；请人工确认是否需 @Skip。`,
		].join("\n"),
	});
}

/**
 * Revert test files where the agent added @Skip/@Disabled, so the repair MR
 * stays clean. `git checkout HEAD -- <file>` reverts to the pre-agent state.
 *
 * Best-effort: if git checkout fails (e.g. untracked new file), log + continue;
 * the G3 path filter already ensures only test/doc paths, and a stray @Skip
 * on a new file is caught by the MR diff review.
 */
async function discardSkipEdits(
	cwd: string,
	skippedFiles: readonly string[],
): Promise<void> {
	if (skippedFiles.length === 0) return;
	const { execFile } = await import("node:child_process");
	const { promisify } = await import("node:util");
	const exec = promisify(execFile);
	for (const testFile of skippedFiles) {
		await exec("git", ["checkout", "HEAD", "--", testFile], { cwd }).catch(
			(err) => {
				logger.warn(
					{ testFile, err },
					"discard-skip: git checkout failed (new file?)",
				);
			},
		);
	}
}

/**
 * Default test runner: Maven then Gradle, real subprocess. Used when no
 * verifyRunner is injected (production). Layer 1 runs only the patch's test
 * classes; layer 2 runs the full suite.
 *
 * Flaky detection (v1 best-effort): a non-zero exit from full regression is
 * classified as "fail" unless the stderr/stdout contains flaky signals
 * ("flaky", "intermittent", test retries). This is coarse — ticket 08
 * (replay/trace) can harden with real flaky-detection heuristics.
 */
class MvnGradleTestRunner implements TestRunner {
	async runRelated(cwd: string, patch: Patch): Promise<TestRunResult> {
		if (!patch.paths.some((p) => TEST_PATH_RE.test(p))) {
			return { status: "green" };
		}
		return this.runMavenOrGradle(cwd, patch);
	}

	async runFull(cwd: string): Promise<TestRunResult> {
		return this.runMavenOrGradle(cwd, undefined);
	}

	private async runMavenOrGradle(
		cwd: string,
		patch: Patch | undefined,
	): Promise<TestRunResult> {
		const { execFile } = await import("node:child_process");
		const { promisify } = await import("node:util");
		const exec = promisify(execFile);
		const isFull = patch === undefined;
		try {
			const hasMvn = await exec("test", ["-f", "pom.xml"], { cwd })
				.then(() => true)
				.catch(() => false);
			if (hasMvn) {
				const testArg = !isFull ? mavenTestArg(patch!.paths) : "";
				// 多模块项目必须 -pl 指定 patch 所属模块，否则 reactor 根跑
				// 会在第一个模块跑（Surefire "No tests were executed"）。
				const module = !isFull ? inferMavenModule(patch!.paths) : undefined;
				const args = [
					"test",
					...(module ? ["-pl", module] : []),
					...(testArg ? [testArg] : []),
				];
				await exec("mvn", args, {
					cwd,
					env: { ...process.env },
					maxBuffer: EXEC_MAX_BUFFER,
				});
				return { status: "green" };
			}
			const hasGradle = await exec("test", ["-f", "build.gradle"], { cwd })
				.then(() => true)
				.catch(() => false);
			if (hasGradle) {
				const taskArg = !isFull ? gradleTaskArg(patch!.paths) : "";
				const args = ["test", ...taskArg.split(" ").filter(Boolean)];
				await exec("./gradlew", args, {
					cwd,
					env: { ...process.env },
					maxBuffer: EXEC_MAX_BUFFER,
				});
				return { status: "green" };
			}
		} catch (err) {
			const output =
				err instanceof Error
					? `${err.message}\n${(err as { stderr?: string }).stderr ?? ""}`
					: String(err);
			// v1 coarse flaky detection: non-zero exit + flaky/intermittent/retry
			// signal in output. Ticket 08 (replay/trace) hardens with real
			// flaky-detection heuristics. Bot scans git diff for @Skip annotations
			// the agent added — does NOT rely on runner-reported test paths.
			if (/flaky|intermittent|retry/i.test(output)) {
				return { status: "flaky" };
			}
			logger.warn(
				{ err },
				isFull ? "verify-full failed" : "verify-related failed",
			);
			return { status: "fail" };
		}
		// No recognizable test runner — don't block (treat as green).
		logger.warn({ cwd }, "no test runner detected; skipping verification");
		return { status: "green" };
	}
}

/**
 * Map patch test paths to dot-separated Maven test class names.
 * e.g. "src/test/java/com/example/FooTest.java" → "com.example.FooTest".
 * Returns "" (run all) if no test paths are discoverable.
 *
 * 必须去掉 src/test/java|groovy|kotlin/ 整个前缀（含 java/groovy/kotlin 子目录），
 * 否则 java/ 被当包名 → -Dtest=java.com.example...（Surefire "No tests were executed"）。
 */
function mavenTestArg(paths: readonly string[]): string {
	const testClasses = paths
		.filter((p) => TEST_PATH_RE.test(p))
		.map((p) =>
			p
				.replace(/^.*\/(?:test|it)\/(?:java|groovy|kotlin)\//, "")
				.replace(/\.java$/, "")
				.replace(/\.groovy$/, "")
				.replace(/\.kt$/, "")
				.replace(/\//g, "."),
		);
	return testClasses.length > 0 ? `-Dtest=${testClasses.join(",")}` : "";
}

/**
 * 多模块 Maven 项目：从 patch 测试路径推断所属模块（路径第一段）。
 * e.g. "ultron-guild-service/src/test/java/..." → "ultron-guild-service"。
 * reactor 根跑 mvn 会在第一个模块（如 ultron-guild-api）跑 → "No tests were executed"。
 */
function inferMavenModule(paths: readonly string[]): string | undefined {
	for (const p of paths) {
		const m = p.match(/^([^/]+)\/src\/(?:test|it)\//);
		if (m) return m[1];
	}
	return undefined;
}

/**
 * Map patch test paths to Gradle --tests args.
 * e.g. "src/test/java/com/example/FooTest.java" → "--tests com.example.FooTest".
 * Returns "" (run all) if no test paths are discoverable.
 */
function gradleTaskArg(paths: readonly string[]): string {
	const testTasks = paths
		.filter((p) => TEST_PATH_RE.test(p))
		.map((p) =>
			p
				.replace(/^.*\/(?:test|it)\//, "")
				.replace(/\.java$/, "")
				.replace(/\//g, "."),
		);
	return testTasks.length > 0 ? `--tests ${testTasks.join(" --tests ")}` : "";
}

/**
 * True if a path points at production source (forbidden by G3).
 * Permissive on purpose: only clearly-production paths are blocked, so a
 * misclassified test path doesn't block a legit fix.
 */
function isProductionPath(p: string): boolean {
	const norm = p.replace(/\\/g, "/");
	// Java/Maven: src/main/java, src/main/kotlin, src/main/resources
	if (/^src\/main\//.test(norm)) return true;
	// Generic: src/ that is NOT under a test dir. (src/test/, src/it/ allowed.)
	if (/^src\//.test(norm) && !/\/test\//.test(norm) && !/\/it\//.test(norm)) {
		return true;
	}
	return false;
}

function log(stage: string, event: PipelineEvent): void {
	logger.info(
		{ stage, projectId: event.projectId, pipelineId: event.pipelineId },
		"runRepair",
	);
}

/** Matches paths under a test/ or it/ source directory. */
const TEST_PATH_RE = /(?:^|\/)(?:test|it)\//;

/**
 * Class-5 early filter: scan CI log for dependency-resolution errors BEFORE
 * spawning the agent. Pure bot code, a deterministic keyword screen over
 * failures whose outcome is a foregone conclusion (escalation) — saves
 * budget and avoids pending /heal decisions with nothing to decide.
 *
 * Compile errors are intentionally NOT screened here: attributing a compile
 * error to src/main (class 5) vs src/test-only (class 2, fixable by editing
 * tests) is the agent's classification call (diagnosis-detail.md owns the
 * class 2/5 boundary). A keyword screen cannot do path attribution reliably
 * across build tools, and a misjudgment would intercept repairable failures
 * (e.g. MR !281 pipeline 100033426: a signature change in the system under
 * test broke test compilation).
 *
 * Scans the whole log — dependency errors can sit late in concatenated
 * multi-job logs; a window cutoff misses them. Returns a human-readable
 * reason when a signal is found, or null when the agent should handle it.
 */
function detectClass5(ciLog: string): string | null {
	const lower = ciLog.toLowerCase();
	for (const signal of CLASS5_SIGNALS) {
		if (lower.includes(signal.keyword)) {
			return signal.reason;
		}
	}
	return null;
}

/**
 * Class-5 signal table — dependency-resolution failures only (see
 * detectClass5 for why compile errors go to the agent). Keywords are
 * case-insensitive (the log is lowercased before matching).
 */
const CLASS5_SIGNALS: ReadonlyArray<{ keyword: string; reason: string }> = [
	{
		keyword: "could not resolve",
		reason: "依赖解析失败（Could not resolve）",
	},
	{ keyword: "cannot resolve dependencies", reason: "依赖解析失败" },
	{
		keyword: "could not find artifact",
		reason: "依赖缺失（Could not find artifact）",
	},
];
