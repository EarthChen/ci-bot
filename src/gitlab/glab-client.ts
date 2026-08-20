/**
 * glab CLI wrapper — fetch CI log / MR diff / pipeline status; create MR.
 *
 * Per G2: glab is the channel for structured GitLab metadata (fast judgment).
 * Auth comes from GITLAB_TOKEN in the env. Tests inject a fake `runGlab`
 * function so no real glab process / MR is created.
 */

import type { Patch, Diagnosis } from "../types.js";
import { formatFailureClass } from "../types.js";

/** Result of a glab mr create call. */
export interface CreatedMr {
	readonly url: string;
}

/** Status of an MR's latest pipeline (the gate the repair must satisfy). */
export interface MrPipelineStatus {
	readonly status: "success" | "failed" | "pending" | "unknown";
	/** Latest pipeline id (for fetching its CI log on failure); null if unknown. */
	readonly pipelineId: number | null;
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
	/** Poll the MR's latest pipeline status (used to verify the repair MR). */
	fetchMrPipelineStatus(
		projectId: string,
		mrIid: number,
	): Promise<MrPipelineStatus>;
	/** 按 source_branch 查询 bot 修复 MR：返回状态、iid 与 web_url。 */
	findMrBySourceBranch(
		projectId: string,
		sourceBranch: string,
	): Promise<{
		status: "opened" | "merged" | "closed";
		iid: number;
		url: string;
	} | null>;
	/** 取指定分支的最新 HEAD sha。 */
	fetchBranchHeadSha(projectId: string, branch: string): Promise<string>;
	/** Create a MR with the given git patch + diagnosis summary. */
	createMr(params: {
		projectId: string;
		sourceBranch: string;
		targetBranch: string;
		title: string;
		diagnosis: Diagnosis;
		patch: Patch;
		/** 描述前缀（如 closed 后重开注明拒绝语境）。 */
		descriptionPrefix?: string;
	}): Promise<CreatedMr>;
}

/** glab-backed implementation. Token read from env at call time. */
export class GlabGitLabClient implements GitLabClient {
	/** Cache of resolved path_with_namespace per numeric project id. */
	private readonly projectPaths = new Map<string, string>();

	constructor(private readonly runGlab: GlabRunner) {}

	/**
	 * Resolve the glab -R repo selector (OWNER/REPO) from a numeric project id.
	 * glab 1.112 -R rejects bare ids ("Expected the [HOST/]OWNER/[NAMESPACE/]REPO
	 * format"), so -R-based commands must go through the resolved path.
	 */
	private async resolveRepoRef(projectId: string): Promise<string> {
		const cached = this.projectPaths.get(projectId);
		if (cached) return cached;
		const out = await this.runGlab(["api", `/projects/${projectId}`]);
		const parsed = safeParse(out);
		const path = parsed?.path_with_namespace;
		if (typeof path !== "string" || path.length === 0) {
			throw new Error(`cannot resolve project path for ${projectId}`);
		}
		this.projectPaths.set(projectId, path);
		return path;
	}

	async fetchMrPipelineStatus(
		projectId: string,
		mrIid: number,
	): Promise<MrPipelineStatus> {
		// MR-triggered pipelines: the latest pipeline for the MR is what we watch.
		const out = await this.runGlab([
			"api",
			`/projects/${projectId}/merge_requests/${mrIid}/pipelines?per_page=1&order_by=id&sort=desc`,
		]);
		const arr = parsePipelines(out);
		const p = arr[0];
		if (!p || !p.status) return { status: "unknown", pipelineId: null };
		const s = String(p.status);
		const status: MrPipelineStatus["status"] =
			s === "success"
				? "success"
				: s === "failed"
					? "failed"
					: s === "pending" ||
					  s === "running" ||
					  s === "created" ||
					  s === "waiting_for_resource"
					? "pending"
					: "unknown";
		return {
			status,
			pipelineId: typeof p.id === "number" ? p.id : null,
		};
	}

	async fetchCiLog(projectId: string, pipelineId: number): Promise<string> {
		// Headless CI-log fetch via the REST API. `glab ci trace` is a TUI-only,
		// interactive command (prompts for a job, emits terminal escapes) and is
		// unusable from a non-interactive worker. So we list the pipeline's jobs
		// then fetch the FAILED jobs' traces and concatenate them.
		//
		// Failed-only on purpose (MR !281 perf): successful/skipped job traces
		// bloat the agent's context (they pushed error markers past any scan
		// window) without diagnostic value. Fallback to all jobs when none is
		// marked failed, so a log is never silently empty.
		const jobsJson = await this.runGlab([
			"api",
			`/projects/${projectId}/pipelines/${pipelineId}/jobs`,
		]);
		const jobs = parseJobs(jobsJson);
		const failed = jobs.filter((j) => j.status === "failed");
		const targets = failed.length > 0 ? failed : jobs;
		const parts: string[] = [];
		for (const job of targets) {
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
		const repo = await this.resolveRepoRef(projectId);
		// glab 1.112 mr diff rejects --project ("Unknown flag"); -R needs OWNER/REPO.
		return this.runGlab(["mr", "diff", String(mrIid), "-R", repo]);
	}

	async findMrBySourceBranch(
		projectId: string,
		sourceBranch: string,
	): Promise<{
		status: "opened" | "merged" | "closed";
		iid: number;
		url: string;
	} | null> {
		const out = await this.runGlab([
			"api",
			`/projects/${projectId}/merge_requests?source_branch=${encodeURIComponent(sourceBranch)}&state=all&per_page=1&order_by=updated_at&sort=desc`,
		]);
		const arr = parseMergeRequests(out);
		const mr = arr[0];
		if (!mr || typeof mr.iid !== "number") return null;
		const state = String(mr.state ?? "");
		const status: "opened" | "merged" | "closed" =
			state === "merged"
				? "merged"
				: state === "closed"
					? "closed"
					: "opened";
		const url =
			typeof mr.web_url === "string" && mr.web_url.length > 0
				? mr.web_url
				: "";
		return { status, iid: mr.iid, url };
	}

	async fetchBranchHeadSha(projectId: string, branch: string): Promise<string> {
		const out = await this.runGlab([
			"api",
			`/projects/${projectId}/repository/branches/${encodeURIComponent(branch)}`,
		]);
		const parsed = safeParse(out);
		const commit = parsed?.commit;
		if (
			commit &&
			typeof commit === "object" &&
			"id" in commit &&
			typeof (commit as { id: unknown }).id === "string"
		) {
			return (commit as { id: string }).id;
		}
		throw new Error(
			`cannot resolve branch head for ${branch} in project ${projectId}`,
		);
	}

	async createMr(params: {
		projectId: string;
		sourceBranch: string;
		targetBranch: string;
		title: string;
		diagnosis: Diagnosis;
		patch: Patch;
		descriptionPrefix?: string;
	}): Promise<CreatedMr> {
		const body =
			(params.descriptionPrefix ?? "") + buildMrBody(params.diagnosis, params.patch);
		const repo = await this.resolveRepoRef(params.projectId);
		// glab mr create outputs JSON with web_url when --output json is used.
		const out = await this.runGlab([
			"mr",
			"create",
			// glab 1.112 -R 只接受 OWNER/REPO（数字 project ID 会被拒），先解析 path。
			"-R",
			repo,
			"--source-branch",
			params.sourceBranch,
			"--target-branch",
			params.targetBranch,
			"--title",
			params.title,
			"--description",
			body,
			"--yes",
			// bot 修复 MR 默认勾选 Delete source branch + Squash commits（MR !281 需求）。
			"--remove-source-branch=true",
			"--squash-before-merge=true",
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
		`**根因分类**: ${formatFailureClass(diagnosis.failureClass)}`,
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

interface PipelineSummary {
	readonly id?: number;
	readonly status?: string;
}

/** Parse the MR-pipelines JSON array returned by `glab api`; tolerate empty/bad output. */
function parsePipelines(s: string): PipelineSummary[] {
	try {
		const parsed = JSON.parse(s);
		return Array.isArray(parsed) ? (parsed as PipelineSummary[]) : [];
	} catch {
		return [];
	}
}

interface MergeRequestSummary {
	readonly iid?: number;
	readonly state?: string;
	readonly web_url?: string;
}

/** Parse the MR list JSON array returned by `glab api`; tolerate empty/bad output. */
function parseMergeRequests(s: string): MergeRequestSummary[] {
	try {
		const parsed = JSON.parse(s);
		return Array.isArray(parsed) ? (parsed as MergeRequestSummary[]) : [];
	} catch {
		return [];
	}
}
