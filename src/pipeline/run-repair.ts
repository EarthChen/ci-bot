/**
 * run-repair — the G2 pipeline orchestration for one event, inside a worker.
 *
 * Sequence:
 *   1. fetch CI log (glab)
 *   2. run agent session (diagnosis → fix → doc sync, one continuous session)
 *   3. on "fixed": create MR with fix diff + diagnosis summary
 *   4. notify DingTalk (success) — bot code, deterministic, agent never holds it
 *   5. on "escalated": notify DingTalk (escalation), no MR
 *
 * Verification (ticket 04) + class-5 early filter (ticket 03) are downstream;
 * this module is the v1 happy-path + escalation-only skeleton.
 */

import type { AgentRunner } from "../agent/runner.js";
import type { GitLabClient } from "../gitlab/glab-client.js";
import type { DingTalkNotifier } from "../notify/dingtalk.js";
import type { PipelineEvent, RepairOutcome, Patch } from "../types.js";
import { logger } from "../util/log.js";

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

  // 2. Run the agent session (diagnosis → fix → doc sync).
  //    The agent self-executes: edits files + runs tests via bash inside the
  //    session. It returns a structured result, NOT file contents.
  let result;
  try {
    result = await agent.run({
      projectId: event.projectId,
      pipelineId: event.pipelineId,
      ref: event.ref,
      sha: event.sha,
      ciLog,
      mrDiff: "",
      cwd: deps.cwd,
    });
  } catch (err) {
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
    patch = await extractPatch(deps.cwd, result.summary);
  } catch (err) {
    return fail(event, dingtalk, "extract-patch", err);
  }
  if (patch.paths.length === 0) {
    await notifyEscalation(dingtalk, event, "agent 报告 fixed 但工作区无改动");
    return { kind: "escalated", summary: "empty patch after agent reported fixed" };
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
  if (!await verifyTestsGreen(deps.cwd, patch)) {
    await notifyEscalation(dingtalk, event, "提取的 test-only patch 重跑测试未绿，疑似 agent 改了生产代码让测试假绿");
    return { kind: "escalated", summary: "re-run tests failed on extracted patch (possible stray src/main edit)" };
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
  return {
    kind: "mr",
    mrUrl: mr.url,
    summary: result.diagnosis.summary,
  };
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
 * Extract the real git patch from the agent's working tree.
 * `git diff` is the authoritative record of what the agent actually changed;
 * the agent's self-reported content is never trusted.
 */
async function extractPatch(cwd: string, summary: string): Promise<Patch> {
  const { execFile } = await import("node:child_process");
  const { promisify } = await import("node:util");
  const exec = promisify(execFile);
  // Ensure the cwd is a git repo with a baseline commit. The agent writes new
  // (untracked) files; `git diff` alone shows nothing for them, so we stage
  // everything then diff against HEAD. In a fresh worker cwd (ticket 02: not
  // a real clone yet — that's ticket 03/06) we `git init` + initial commit so
  // the baseline exists before the agent's edits are captured.
  await exec("git", ["init", "--quiet"], { cwd }).catch(() => {});
  const hasHead = await exec("git", ["rev-parse", "--quiet", "HEAD"], { cwd })
    .then(() => true).catch(() => false);
  if (!hasHead) {
    // Create an empty baseline commit so the agent's new files show as changes.
    await exec("git", ["commit", "--quiet", "--allow-empty", "-m", "ci-self-heal baseline"], { cwd });
  }
  // Stage the agent's edits so untracked new files appear in the diff.
  // Exclude bot-written temp files (CI log, MR diff spill) + the pi agent dir
  // — they must never end up in the MR patch.
  await exec("git", ["add", "-A", ".", ":^ci-log.txt", ":^mr-diff.patch", ":^.pi-agent"], { cwd });
  const { stdout: diff } = await exec("git", ["diff", "--no-color", "--cached", "--", ":^ci-log.txt", ":^mr-diff.patch", ":^.pi-agent"], { cwd });
  const { stdout: namesOut } = await exec("git", ["diff", "--name-only", "--cached", "--", ":^ci-log.txt", ":^mr-diff.patch", ":^.pi-agent"], { cwd });
  const paths = namesOut.split("\n").map((s) => s.trim()).filter(Boolean);
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
    const hasMvn = await exec("test", ["-f", "pom.xml"], { cwd }).then(() => true).catch(() => false);
    if (hasMvn) {
      // Run only the test classes the patch touches, if discoverable.
      const testClasses = patch.paths
        .filter((p) => TEST_PATH_RE.test(p))
        .map((p) => p.replace(/^.*\/(?:test|it)\//, "").replace(/\.java$/, "").replace(/\//g, "."));
      const testArg = testClasses.length > 0 ? `-Dtest=${testClasses.join(",")}` : "";
      const args = ["test", ...(testArg ? [testArg] : [])];
      await exec("mvn", args, { cwd, env: { ...process.env } });
      return true;
    }
    const hasGradle = await exec("test", ["-f", "build.gradle"], { cwd }).then(() => true).catch(() => false);
    if (hasGradle) {
      const testTasks = patch.paths
        .filter((p) => TEST_PATH_RE.test(p))
        .map((p) => p.replace(/^.*\/(?:test|it)\//, "").replace(/\.java$/, "").replace(/\//g, "."));
      const taskArg = testTasks.length > 0 ? `--tests ${testTasks.join(" --tests ")}` : "";
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
  logger.info({ stage, projectId: event.projectId, pipelineId: event.pipelineId }, "runRepair");
}

/** Matches paths under a test/ or it/ source directory. */
const TEST_PATH_RE = /(?:^|\/)(?:test|it)\//;
