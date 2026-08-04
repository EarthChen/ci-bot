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
import type { PipelineEvent, RepairOutcome } from "../types.js";
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

  // 3 + 4. Branch on the structured agent result.
  if (result.kind === "fixed") {
    const sourceBranch = `ci-self-heal/${event.ref}-${shortSha(event.sha)}`;
    let mr;
    try {
      mr = await glab.createMr({
        projectId: event.projectId,
        sourceBranch,
        targetBranch: event.ref,
        title: `[ci-self-heal] ${result.diagnosis.summary}`,
        diagnosis: result.diagnosis,
        fix: result.fix,
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

  // result.kind === "escalated"
  await notifyEscalation(dingtalk, event, result.reason);
  return { kind: "escalated", summary: result.reason };
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
  // the real error — swallow + log.
  void dingtalk
    .send({
      title: "CI 自愈 Bot 异常",
      text: `项目 ${event.projectId} pipeline ${event.pipelineId} 在 ${stage} 阶段失败：${error}`,
    })
    .catch(() => {});
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

function log(stage: string, event: PipelineEvent): void {
  logger.info({ stage, projectId: event.projectId, pipelineId: event.pipelineId }, "runRepair");
}
