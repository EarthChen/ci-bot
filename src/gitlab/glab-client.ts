/**
 * glab CLI wrapper — fetch CI log / MR diff / pipeline status; create MR.
 *
 * Per G2: glab is the channel for structured GitLab metadata (fast judgment).
 * Auth comes from GITLAB_TOKEN in the env. Tests inject a fake `runGlab`
 * function so no real glab process / MR is created.
 */

import type { FixDiff, Diagnosis } from "../types.js";

/** Result of a glab mr create call. */
export interface CreatedMr {
  readonly url: string;
}

/**
 * A function that runs a glab CLI subcommand and returns stdout.
 * Injection seam: production uses the real child_process; tests use a fake.
 */
export type GlabRunner = (args: readonly string[]) => Promise<string>;

export interface GitLabClient {
  /** Fetch the failed pipeline's job logs (aggregated). */
  fetchCiLog(projectId: string, pipelineId: number): Promise<string>;
  /** Fetch the MR diff (if a related MR exists) — empty string if none. */
  fetchMrDiff(projectId: string, mrIid: number): Promise<string>;
  /** Create a MR with the given fix diff + diagnosis summary. */
  createMr(params: {
    projectId: string;
    sourceBranch: string;
    targetBranch: string;
    title: string;
    diagnosis: Diagnosis;
    fix: FixDiff;
  }): Promise<CreatedMr>;
}

/** glab-backed implementation. Token read from env at call time. */
export class GlabGitLabClient implements GitLabClient {
  constructor(private readonly runGlab: GlabRunner) {}

  async fetchCiLog(projectId: string, pipelineId: number): Promise<string> {
    // glab ci trace --raw streams the job log; we get all jobs for the pipeline.
    return this.runGlab([
      "ci",
      "trace",
      "--project",
      String(projectId),
      "--pipeline-id",
      String(pipelineId),
      "--raw",
    ]);
  }

  async fetchMrDiff(projectId: string, mrIid: number): Promise<string> {
    return this.runGlab([
      "mr",
      "diff",
      String(mrIid),
      "--project",
      String(projectId),
    ]);
  }

  async createMr(params: {
    projectId: string;
    sourceBranch: string;
    targetBranch: string;
    title: string;
    diagnosis: Diagnosis;
    fix: FixDiff;
  }): Promise<CreatedMr> {
    const body = buildMrBody(params.diagnosis, params.fix);
    // glab mr create outputs JSON with web_url when --output json is used.
    const out = await this.runGlab([
      "mr",
      "create",
      "--project",
      String(params.projectId),
      "--source-branch",
      params.sourceBranch,
      "--target-branch",
      params.targetBranch,
      "--title",
      params.title,
      "--description",
      body,
      "--yes",
      "--output",
      "json",
    ]);
    const parsed = safeParse(out);
    const url = parsed?.web_url ?? parsed?.url ?? "";
    return { url: typeof url === "string" ? url : "" };
  }
}

function buildMrBody(diagnosis: Diagnosis, fix: FixDiff): string {
  return [
    "## CI 自愈 Bot 修复",
    "",
    `**根因分类**: class ${diagnosis.failureClass}`,
    `**诊断摘要**: ${diagnosis.summary}`,
    "",
    "### 修复内容",
    fix.summary,
    "",
    "### 改动文件",
    ...fix.files.map((f) => `- \`${f.path}\``),
    "",
    "---",
    "_由 ci-self-heal-bot 自动生成，需人工 review 后 merge。_",
  ].join("\n");
}

function safeParse(s: string): Record<string, unknown> | null {
  try {
    return JSON.parse(s) as Record<string, unknown>;
  } catch {
    return null;
  }
}
