/**
 * Core domain types shared across the pipeline.
 *
 * These are the contracts between modules — the seam the e2e test exercises.
 * Keep them minimal and behavior-focused (no implementation details).
 */

/**
 * A GitLab pipeline failure event, normalized from the raw webhook payload.
 * One pipeline = one event (jobs aggregated naturally by GitLab's pipeline-level webhook).
 */
export interface PipelineEvent {
	/** GitLab project id (e.g. 42 or "group/project"). */
	readonly projectId: string;
	/** Pipeline id — used for idempotent dedup. */
	readonly pipelineId: number;
	/** Full ref (branch) the pipeline ran on. */
	readonly ref: string;
	/** Commit sha the pipeline ran for. */
	readonly sha: string;
	/** Project URL (used to derive clone/MR endpoints). */
	readonly projectUrl: string;
}

/** G1 failure root-cause class (v1 only auto-fixes 1/2/3; 4/5 escalate). */
export type FailureClass = 1 | 2 | 3 | 4 | 5;

/** Structured diagnosis output the agent produces. */
export interface Diagnosis {
	/** Which G1 class the failure was classified into. */
	readonly failureClass: FailureClass;
	/** Human-readable root-cause summary. */
	readonly summary: string;
}

/**
 * The structured result an agent session outputs at the end.
 *
 * The agent self-executes (edits files + runs tests via bash inside the
 * session). It does NOT output file contents — the bot extracts the real
 * patch from `git diff` (authoritative) and G3-validates it post-hoc.
 */
export type AgentResult =
	| {
			readonly kind: "fixed";
			readonly diagnosis: Diagnosis;
			readonly summary: string;
	  }
	| {
			readonly kind: "escalated";
			readonly diagnosis: Diagnosis;
			readonly reason: string;
	  };

/** A real git patch the bot extracts from the agent's working tree. */
export interface Patch {
	/** Unified-diff text (output of `git diff`). */
	readonly diff: string;
	/** Repo-relative paths the patch touches. */
	readonly paths: readonly string[];
	/** Short summary for the MR body. */
	readonly summary: string;
}

/** Final outcome the bot records for a single pipeline (drives MR + DingTalk). */
export type RepairOutcome =
	| { readonly kind: "mr"; readonly mrUrl: string; readonly summary: string }
	| { readonly kind: "escalated"; readonly summary: string }
	| {
			readonly kind: "failed";
			readonly summary: string;
			readonly error: string;
	  };
