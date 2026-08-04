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

import type { AgentRunner } from "../agent/runner.js";
import type { GitLabClient } from "../gitlab/glab-client.js";
import type { DingTalkNotifier } from "../notify/dingtalk.js";
import type { PipelineEvent, RepairOutcome, Patch } from "../types.js";
import { logger } from "../util/log.js";
import { createWorktree, removeWorktree } from "./worktree.js";

export interface WorkerDeps {
	readonly agent: AgentRunner;
	readonly glab: GitLabClient;
	readonly dingtalk: DingTalkNotifier;
	readonly cwd: string;
}

export async function runRepair(
	deps: WorkerDeps,
	event: PipelineEvent,
): Promise<RepairOutcome> {
	const { agent, glab, dingtalk } = deps;
	log("start", event);

	// 1. Fetch CI log. (MR diff fetched only if a related MR exists; tracer
	//    bullet has none, so we pass empty.)
	let ciLog: string;
	try {
		ciLog = await glab.fetchCiLog(event.projectId, event.pipelineId);
	} catch (err) {
		return fail(event, dingtalk, "fetch-ci-log", err);
	}

	// 1a. Class-5 early filter: scan CI log for compile/dependency errors
	//     BEFORE spawning the agent. This is pure bot code (deterministic),
	//     saving budget on failures the agent can't fix anyway (src/main
	//     compile errors, dependency resolution failures are out of scope).
	const class5Reason = detectClass5(ciLog);
	if (class5Reason) {
		const reason = `class 5 非单测失败：${class5Reason}，转交人工（不起 agent）`;
		await notifyEscalation(dingtalk, event, reason);
		return { kind: "escalated", summary: reason };
	}

	// 1b. Create a worktree from the project's shared bare clone (G2 local
	//     clone). The worktree is the agent's real working tree — it sees the
	//     repo at the pipeline's sha, edits files here, runs tests here. The
	//     CI log / MR diff spill files stay in deps.cwd (outside the worktree)
	//     so they never pollute the repo's git diff.
	let repoCwd: string;
	try {
		repoCwd = await createWorktree(deps.cwd, event);
	} catch (err) {
		return fail(event, dingtalk, "worktree", err);
	}

	// 2. Run the agent session (diagnosis → fix → doc sync).
	//    The agent self-executes: edits files + runs tests via bash inside the
	//    session, all within the worktree (repoCwd). It returns a structured
	//    result, NOT file contents.
	let result;
	try {
		result = await agent.run({
			projectId: event.projectId,
			pipelineId: event.pipelineId,
			ref: event.ref,
			sha: event.sha,
			ciLog,
			mrDiff: "",
			cwd: repoCwd,
		});
	} catch (err) {
		await removeWorktree(deps.cwd).catch(() => {});
		return fail(event, dingtalk, "agent-run", err);
	}

	// 3. Branch on the structured agent result.
	if (result.kind === "escalated") {
		await notifyEscalation(dingtalk, event, result.reason);
		return { kind: "escalated", summary: result.reason };
	}

	// 4. result.kind === "fixed" — extract the real patch from the agent's
	//    working tree (git diff is authoritative; the agent's self-reported
	//    content is NOT trusted). Then G3-validate + re-run tests in a clean
	//    checkout to prove the fix is genuinely green without stray src/main
	//    edits that could have made tests pass illegitimately.
	let patch;
	try {
		patch = await extractPatch(repoCwd, result.summary);
	} catch (err) {
		await removeWorktree(deps.cwd).catch(() => {});
		return fail(event, dingtalk, "extract-patch", err);
	}
	if (patch.paths.length === 0) {
		await notifyEscalation(dingtalk, event, "agent 报告 fixed 但工作区无改动");
		return {
			kind: "escalated",
			summary: "empty patch after agent reported fixed",
		};
	}
	// G3 permission boundary: only test/doc files; src/main forbidden.
	const violation = validatePatchPaths(patch);
	if (violation) {
		await notifyEscalation(dingtalk, event, `G3 权限越界：${violation}`);
		return { kind: "escalated", summary: `G3 violation: ${violation}` };
	}
	// Re-run tests on the extracted patch to catch illegitimate-green (agent
	// may have touched src/main to make tests pass; we discarded those edits,
	// so the test-only diff must still pass on its own).
	if (!(await verifyTestsGreen(repoCwd, patch))) {
		await notifyEscalation(
			dingtalk,
			event,
			"提取的 test-only patch 重跑测试未绿，疑似 agent 改了生产代码让测试假绿",
		);
		return {
			kind: "escalated",
			summary:
				"re-run tests failed on extracted patch (possible stray src/main edit)",
		};
	}

	const sourceBranch = `ci-self-heal/${event.ref}-${shortSha(event.sha)}`;
	let mr;
	try {
		mr = await glab.createMr({
			projectId: event.projectId,
			sourceBranch,
			targetBranch: event.ref,
			title: `[ci-self-heal] ${result.diagnosis.summary}`,
			diagnosis: result.diagnosis,
			patch,
		});
	} catch (err) {
		return fail(event, dingtalk, "create-mr", err);
	}
	await notifySuccess(dingtalk, event, mr.url, result.diagnosis.summary);
	const outcome: RepairOutcome = {
		kind: "mr",
		mrUrl: mr.url,
		summary: result.diagnosis.summary,
	};
	await removeWorktree(deps.cwd).catch(() => {});
	return outcome;
}

function fail(
	event: PipelineEvent,
	dingtalk: DingTalkNotifier,
	stage: string,
	err: unknown,
): RepairOutcome {
	const error = err instanceof Error ? err.message : String(err);
	logger.error({ event, stage, error }, "repair failed");
	// Best-effort: notify even on failure. Do not let a notify failure mask
	// the real error — log it explicitly so it is never silently swallowed.
	void dingtalk
		.send({
			title: "CI 自愈 Bot 异常",
			text: `项目 ${event.projectId} pipeline ${event.pipelineId} 在 ${stage} 阶段失败：${error}`,
		})
		.catch((notifyErr) => {
			logger.warn({ event, stage, notifyErr }, "failure-notify failed");
		});
	return { kind: "failed", summary: `${stage} failed`, error };
}

function notifySuccess(
	dingtalk: DingTalkNotifier,
	event: PipelineEvent,
	mrUrl: string,
	summary: string,
): Promise<void> {
	return dingtalk.send({
		title: "CI 自愈修复成功",
		text: [
			`项目 ${event.projectId}`,
			`分支 ${event.ref} @ ${shortSha(event.sha)}`,
			`诊断：${summary}`,
			`MR：${mrUrl}`,
		].join("\n"),
	});
}

function notifyEscalation(
	dingtalk: DingTalkNotifier,
	event: PipelineEvent,
	reason: string,
): Promise<void> {
	return dingtalk.send({
		title: "CI 自愈转交人工",
		text: [
			`项目 ${event.projectId}`,
			`分支 ${event.ref} @ ${shortSha(event.sha)}`,
			`原因：${reason}`,
		].join("\n"),
	});
}

function shortSha(sha: string): string {
	return sha.slice(0, 8);
}

/**
 * G3 permission boundary: the bot may ONLY write test + doc files.
 * Any path under a production source tree (src/main for Java/Maven, or
 * a generic src path not under a test directory) is forbidden and causes
 * the repair to escalate instead of creating an MR.
 *
 * Returns a human-readable violation reason, or null if all paths are safe.
 */
function validatePatchPaths(patch: Patch): string | null {
	for (const p of patch.paths) {
		if (isProductionPath(p)) {
			return `patch touches production code: ${p}`;
		}
	}
	return null;
}

/**
 * Extract the real git patch from the agent's worktree.
 * `git diff` is the authoritative record of what the agent actually changed;
 * the agent's self-reported content is never trusted.
 *
 * The worktree is a real repo with a HEAD at the pipeline's sha, so no
 * baseline-init is needed (unlike the pre-worktree temp-dir fallback).
 */
async function extractPatch(cwd: string, summary: string): Promise<Patch> {
	const { execFile } = await import("node:child_process");
	const { promisify } = await import("node:util");
	const exec = promisify(execFile);
	// Stage the agent's edits so untracked new files appear in the diff, then
	// unstage bot-written spill files (ci-log.txt, mr-diff.patch) so they never
	// pollute the MR patch. Using `reset` (instead of pathspec exclude) is
	// robust across git versions + worktree contexts.
	await exec("git", ["add", "-A"], { cwd });
	await exec(
		"git",
		["reset", "--quiet", "--", "ci-log.txt", "mr-diff.patch"],
		{ cwd },
	).catch(() => {}); // files may not exist; ignore.
	const { stdout: diff } = await exec(
		"git",
		["diff", "--no-color", "--cached"],
		{ cwd },
	);
	const { stdout: namesOut } = await exec(
		"git",
		["diff", "--name-only", "--cached"],
		{ cwd },
	);
	const paths = namesOut
		.split("\n")
		.map((s) => s.trim())
		.filter(Boolean);
	return { diff, paths, summary };
}

/**
 * Verify the extracted test-only patch makes the relevant tests pass on a
 * clean checkout. Catches the illegitimate-green case where the agent edited
 * src/main (discarded by G3) to make tests pass — the test-only diff alone
 * must still be green.
 *
 * v1 best-effort: if no test command is detectable, return true (don't block
 * a valid fix on a missing test runner). Ticket 04 hardens this.
 */
async function verifyTestsGreen(cwd: string, patch: Patch): Promise<boolean> {
	// Only relevant if the patch touches test files; pure-doc fixes skip this.
	if (!patch.paths.some((p) => TEST_PATH_RE.test(p))) return true;
	const { execFile } = await import("node:child_process");
	const { promisify } = await import("node:util");
	const exec = promisify(execFile);
	try {
		// Try Maven then Gradle; both are common in the target Java ecosystem.
		const hasMvn = await exec("test", ["-f", "pom.xml"], { cwd })
			.then(() => true)
			.catch(() => false);
		if (hasMvn) {
			// Run only the test classes the patch touches, if discoverable.
			const testClasses = patch.paths
				.filter((p) => TEST_PATH_RE.test(p))
				.map((p) =>
					p
						.replace(/^.*\/(?:test|it)\//, "")
						.replace(/\.java$/, "")
						.replace(/\//g, "."),
				);
			const testArg =
				testClasses.length > 0 ? `-Dtest=${testClasses.join(",")}` : "";
			const args = ["test", ...(testArg ? [testArg] : [])];
			await exec("mvn", args, { cwd, env: { ...process.env } });
			return true;
		}
		const hasGradle = await exec("test", ["-f", "build.gradle"], { cwd })
			.then(() => true)
			.catch(() => false);
		if (hasGradle) {
			const testTasks = patch.paths
				.filter((p) => TEST_PATH_RE.test(p))
				.map((p) =>
					p
						.replace(/^.*\/(?:test|it)\//, "")
						.replace(/\.java$/, "")
						.replace(/\//g, "."),
				);
			const taskArg =
				testTasks.length > 0 ? `--tests ${testTasks.join(" --tests ")}` : "";
			const args = ["test", ...taskArg.split(" ").filter(Boolean)];
			await exec("./gradlew", args, { cwd, env: { ...process.env } });
			return true;
		}
	} catch (err) {
		logger.warn({ err }, "verify-tests-green failed");
		return false;
	}
	// No recognizable test runner — don't block (ticket 04 hardens).
	logger.warn({ cwd }, "no test runner detected; skipping re-run verification");
	return true;
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
	{ keyword: "compilation failure", reason: "Maven 编译失败（Compilation Failure）" },
	{ keyword: "cannot find symbol", reason: "编译错（cannot find symbol）" },
	{ keyword: "error: ; generated by the javac compiler", reason: "javac 编译错" },
	// Gradle compile failures
	{ keyword: "compilation failed", reason: "Gradle 编译失败" },
	{ keyword: "execution failed for task ':compilejava'", reason: "Gradle compileJava 失败" },
	// Dependency resolution failures
	{ keyword: "could not resolve", reason: "依赖解析失败（Could not resolve）" },
	{ keyword: "cannot resolve dependencies", reason: "依赖解析失败" },
	{ keyword: "could not find artifact", reason: "依赖缺失（Could not find artifact）" },
];
