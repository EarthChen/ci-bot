/**
 * run-repair — the G2 pipeline orchestration for one event, inside a worker.
 *
 * Sequence:
 *   1. fetch CI log (glab)
 *   1a. class-5 early filter (keyword screen) — skip agent, save budget
 *   2. create worktree + run agent session (diagnosis → fix → doc sync)
 *   3. on "fixed": extract real git patch → G3 validate → re-run tests → create MR
 *   4. notify DingTalk (success) — bot code, deterministic, agent never holds it
 *   5. on "escalated": notify DingTalk (escalation), no MR
 */

import type { AgentRunner, AgentRunInput } from "../agent/runner.js";
import { parseMrIid } from "../agent/runner.js";
import type { GitLabClient, MrPipelineStatus } from "../gitlab/glab-client.js";
import type { DingTalkNotifier } from "../notify/dingtalk.js";
import type { PipelineEvent, RepairOutcome, Patch, AgentResult } from "../types.js";
import { logger } from "../util/log.js";
import type { Worktree } from "./worktree.js";
import { finishRepair, repairCost } from "./repair-outcome.js";

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
 */
export function isDecidableEscalation(result: AgentResult): boolean {
	return (
		result.kind === "escalated" &&
		result.source === "agent" &&
		Boolean(result.diagnosis)
	);
}

export async function runRepair(
	deps: WorkerDeps,
	event: PipelineEvent,
): Promise<RepairOutcome> {
	const { agent, glab, dingtalk, worktree } = deps;
	log("start", event);

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

	// 1a. Class-5 early filter: scan CI log for compile/dependency errors
	//     BEFORE spawning the agent. This is pure bot code (deterministic),
	//     saving budget on failures the agent can't fix anyway (src/main
	//     compile errors, dependency resolution failures are out of scope).
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

	// 2. Run the agent session (diagnosis → fix → doc sync).
	//    The agent self-executes: edits files + runs tests via bash inside the
	//    session, all within the worktree (repoCwd). It returns a structured
	//    result, NOT file contents.
	const agentStartedAt = Date.now();
	const sourceBranch = `ci-self-heal/${event.ref}-${shortSha(event.sha)}`;
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
	};
	let result;
	try {
		result = await agent.run(agentInput);
	} catch (err) {
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
	const agentMetrics = {
		turns: agentTurns,
		tokens: agentTokens,
		cost: repairCost(agentTokens),
		durationMs: Date.now() - agentStartedAt,
	} as const;

	// 3. Branch on the structured agent result.
	if (result.kind === "escalated") {
		// Scene retention (T03): only an agent-initiated escalation with a
		// diagnosis is decidable — finishRepair then skips the worktree cleanup
		// and flags the outcome so the main process registers a decision.
		const decidable = isDecidableEscalation(result);
		return finishRepair({
			dingtalk,
			cwd: deps.cwd,
			event,
			removeWorktree: worktree.remove,
			result: {
				kind: "escalated",
				summary: result.reason,
				diagnosis: result.diagnosis,
				metrics: agentMetrics,
				...(decidable ? { decidable: true } : {}),
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
			agentInput,
			agentMetrics,
		});
	} finally {
		agent.close();
	}
	return outcome;
}

/**
 * Post-"fixed" pipeline: extract the real patch, whitelist-validate it, then
 * monitor the MR's CI. If CI stays red, reuse the agent's open session to
 * continue fixing (updating the same MR), up to CIHEAL_RETRY_LIMIT times.
 */
async function repairFixed(args: {
	deps: WorkerDeps;
	event: PipelineEvent;
	repoCwd: string;
	result: Extract<AgentResult, { kind: "fixed" }>;
	diffFiles: readonly string[];
	agentInput: AgentRunInput;
	agentMetrics: { turns: number; tokens: number; cost: number; durationMs: number };
}): Promise<RepairOutcome> {
	const { deps, event, repoCwd, result, diffFiles, agentInput } = args;
	const { glab, dingtalk, worktree } = deps;

	const patch = await extractPatch(repoCwd, result.summary, event.sha);
	if (patch.paths.length === 0) {
		return finishRepair({
			dingtalk,
			cwd: deps.cwd,
			event,
			removeWorktree: worktree.remove,
			result: {
				kind: "escalated",
				summary: "empty patch after agent reported fixed",
				diagnosis: result.diagnosis,
				diff: patch.diff,
				metrics: args.agentMetrics,
			},
		});
	}
	const g3 = validatePatchPaths(patch, diffFiles);
	if (g3) {
		return finishRepair({
			dingtalk,
			cwd: deps.cwd,
			event,
			removeWorktree: worktree.remove,
			result: {
				kind: "escalated",
				summary: `G3/diff 违规：${g3}`,
				diagnosis: result.diagnosis,
				diff: patch.diff,
				metrics: args.agentMetrics,
			},
		});
	}
	// 两层测试验证（verifyTwoLayer）v1 仍禁用：MR-CI 重跑即为 re-verify；
	// 其 Mvn/Gradle 硬编码对非 Java 项目误杀，故靠 CI 重跑兜底。
	void verifyTwoLayer;
	if (!result.mrUrl) {
		return finishRepair({
			dingtalk,
			cwd: deps.cwd,
			event,
			removeWorktree: worktree.remove,
			result: {
				kind: "escalated",
				summary: "agent reported fixed but did not create MR (no mrUrl)",
				diagnosis: result.diagnosis,
				diff: patch.diff,
				metrics: args.agentMetrics,
			},
		});
	}

	// Monitor the MR's CI + retry by reusing the agent session.
	const mrIid = parseMrIid(result.mrUrl);
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
				result.mrUrl,
				newCiLog,
			);
			if (cont.kind === "escalated") {
				return finishRepair({
					dingtalk,
					cwd: deps.cwd,
					event,
					removeWorktree: worktree.remove,
					result: {
						kind: "escalated",
						summary: cont.reason,
						diagnosis: cont.diagnosis,
						diff: currentPatch.diff,
						metrics: args.agentMetrics,
					},
				});
			}
			const p2 = await extractPatch(repoCwd, cont.summary, event.sha);
			const g3b = validatePatchPaths(p2, diffFiles);
			if (p2.paths.length === 0 || g3b) {
				return finishRepair({
					dingtalk,
					cwd: deps.cwd,
					event,
					removeWorktree: worktree.remove,
					result: {
						kind: "escalated",
						summary:
							p2.paths.length === 0
								? "retry produced empty patch"
								: `retry G3/diff 违规：${g3b}`,
						diagnosis: cont.diagnosis,
						diff: p2.diff,
						metrics: args.agentMetrics,
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
			result: {
				kind: "mr",
				summary: currentResult.diagnosis.summary,
				diagnosis: currentResult.diagnosis,
				diff: currentPatch.diff,
				mrUrl: currentResult.mrUrl ?? result.mrUrl,
				metrics: args.agentMetrics,
			},
		});
	}
	return finishRepair({
		dingtalk,
		cwd: deps.cwd,
		event,
		removeWorktree: worktree.remove,
		result: {
			kind: "escalated",
		summary: `MR CI 仍红，重试 ${attempt} 次后转交人工`,
		diagnosis: currentResult.diagnosis,
		diff: currentPatch.diff,
		metrics: args.agentMetrics,
		},
	});
}

/** Spill files (CI log / MR diff) the bot writes into the worktree — must
 *  never appear in the extracted patch. */
const SPILL_RE = /(^|\/)(ci-log.*\.txt|mr-diff\.patch)$/;

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

/** Parse the changed file set from a `git diff` text (MR diff). */
function parseDiffFiles(diff: string): string[] {
	const files: string[] = [];
	for (const line of diff.split("\n")) {
		const m = line.match(/^diff --git a\/(.+?) b\/(.+?)\s*$/);
		if (m) files.push(m[2]);
	}
	return files;
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
			return !SPILL_RE.test(path);
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
 * Extract the real git patch from the agent's worktree.
 * `git diff <baseSha>` is authoritative — captures all agent changes
 * (committed or not) relative to the pipeline's sha. Agent self-reported
 * content is never trusted.
 */
async function extractPatch(
	cwd: string,
	summary: string,
	baseSha: string,
): Promise<Patch> {
	const { execFile } = await import("node:child_process");
	const { promisify } = await import("node:util");
	const exec = promisify(execFile);
	// Stage agent's edits so untracked new files appear in the diff (baseSha
	// has no record of them). Spill files live outside repoCwd so they never
	// pollute the patch.
	await exec("git", ["add", "-A"], { cwd });
	const { stdout: rawDiff } = await exec(
		"git",
		["diff", "--no-color", baseSha],
		{ cwd },
	);
	const { stdout: namesOut } = await exec(
		"git",
		["diff", "--name-only", baseSha],
		{ cwd },
	);
	const paths = namesOut
		.split("\n")
		.map((s) => s.trim())
		.filter(Boolean)
		.filter((p) => !SPILL_RE.test(p));
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
			{ cwd },
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
				{ cwd },
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
				await exec("mvn", args, { cwd, env: { ...process.env } });
				return { status: "green" };
			}
			const hasGradle = await exec("test", ["-f", "build.gradle"], { cwd })
				.then(() => true)
				.catch(() => false);
			if (hasGradle) {
				const taskArg = !isFull ? gradleTaskArg(patch!.paths) : "";
				const args = ["test", ...taskArg.split(" ").filter(Boolean)];
				await exec("./gradlew", args, { cwd, env: { ...process.env } });
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
 * Class-5 early filter: scan CI log for compile/dependency errors BEFORE
 * spawning the agent. These failures are out of scope (src/main compile
 * errors, dependency resolution) — the agent can't fix them (G3 forbids
 * src/main), and running a session wastes budget.
 *
 * Pure bot code, deterministic keyword screen. Returns a human-readable
 * reason when a class-5 signal is found, or null if the log looks like a
 * real unit-test failure (agent should handle it).
 */
function detectClass5(ciLog: string): string | null {
	// Normalize: case-insensitive, first 8 KB is enough for signal detection
	// (CI logs can be huge; we don't need to scan megabytes for keywords).
	const sample = ciLog.slice(0, 8192).toLowerCase();
	for (const signal of CLASS5_SIGNALS) {
		if (sample.includes(signal.keyword)) {
			return signal.reason;
		}
	}
	return null;
}

/**
 * Class-5 signal table. Keywords are case-insensitive (sample is lowercased).
 * Each entry maps a CI-log signal to a human-readable reason for escalation.
 */
const CLASS5_SIGNALS: ReadonlyArray<{ keyword: string; reason: string }> = [
	// Maven compile failures (note: "BUILD FAILURE" alone is ambiguous —
	// Maven test failures also print it. We match the compile-specific lines.)
	{
		keyword: "compilation failure",
		reason: "Maven 编译失败（Compilation Failure）",
	},
	{ keyword: "cannot find symbol", reason: "编译错（cannot find symbol）" },
	{
		keyword: "error: ; generated by the javac compiler",
		reason: "javac 编译错",
	},
	// Gradle compile failures
	{ keyword: "compilation failed", reason: "Gradle 编译失败" },
	{
		keyword: "execution failed for task ':compilejava'",
		reason: "Gradle compileJava 失败",
	},
	// Dependency resolution failures
	{ keyword: "could not resolve", reason: "依赖解析失败（Could not resolve）" },
	{ keyword: "cannot resolve dependencies", reason: "依赖解析失败" },
	{
		keyword: "could not find artifact",
		reason: "依赖缺失（Could not find artifact）",
	},
];
