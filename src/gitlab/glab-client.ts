/**
 * glab CLI wrapper — fetch CI log / MR diff / pipeline status; create MR.
 *
 * Per G2: glab is the channel for structured GitLab metadata (fast judgment).
 * Auth comes from GITLAB_TOKEN in the env. Tests inject a fake `runGlab`
 * function so no real glab process / MR is created.
 */

import type { Patch, Diagnosis } from "../types.js";

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
	/** Create a MR with the given git patch + diagnosis summary. */
	createMr(params: {
		projectId: string;
		sourceBranch: string;
		targetBranch: string;
		title: string;
		diagnosis: Diagnosis;
		patch: Patch;
	}): Promise<CreatedMr>;
}

/** glab-backed implementation. Token read from env at call time. */
export class GlabGitLabClient implements GitLabClient {
	constructor(private readonly runGlab: GlabRunner) {}

	async fetchCiLog(projectId: string, pipelineId: number): Promise<string> {
		// Headless CI-log fetch via the REST API. `glab ci trace` is a TUI-only,
		// interactive command (prompts for a job, emits terminal escapes) and is
		// unusable from a non-interactive worker. So we list the pipeline's jobs
		// then fetch each job's trace and concatenate them.
		const jobsJson = await this.runGlab([
			"api",
			`/projects/${projectId}/pipelines/${pipelineId}/jobs`,
		]);
		const jobs = parseJobs(jobsJson);
		const parts: string[] = [];
		for (const job of jobs) {
			if (job.id == null) continue;
			const trace = await this.runGlab([
				"api",
				`/projects/${projectId}/jobs/${job.id}/trace`,
			]);
			parts.push(
				`# Job ${job.id} ${job.name ?? ""} [${job.status ?? ""}]${
					job.stage ? ` stage=${job.stage}` : ""
				}\n${trace}`,
			);
		}
		return parts.join("\n\n");
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
		patch: Patch;
	}): Promise<CreatedMr> {
		const body = buildMrBody(params.diagnosis, params.patch);
		// glab mr create outputs JSON with web_url when --output json is used.
		const out = await this.runGlab([
			"mr",
			"create",
			// glab 1.112 mr create 用 -R/--repo 指定项目（支持 OWNER/REPO 或 project ID）；
			// --project 是 fetch 路径用的，mr create 不支持（"Unknown flag: --project"）。
			"-R",
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

function buildMrBody(diagnosis: Diagnosis, patch: Patch): string {
	return [
		"## CI 自愈 Bot 修复",
		"",
		`**根因分类**: class ${diagnosis.failureClass}`,
		`**诊断摘要**: ${diagnosis.summary}`,
		"",
		"### 修复内容",
		patch.summary,
		"",
		"### 改动文件",
		...patch.paths.map((p) => `- \`${p}\``),
		"",
		"### Patch",
		"```diff",
		patch.diff,
		"```",
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

interface JobSummary {
	readonly id?: number;
	readonly name?: string;
	readonly status?: string;
	readonly stage?: string;
}

/** Parse the pipeline-jobs JSON array returned by `glab api`; tolerate empty/bad output. */
function parseJobs(s: string): JobSummary[] {
	try {
		const parsed = JSON.parse(s);
		return Array.isArray(parsed) ? (parsed as JobSummary[]) : [];
	} catch {
		return [];
	}
}
