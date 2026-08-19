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
	/** Full ref (branch) the pipeline ran on. For MR-triggered pipelines
	 *  this is `refs/merge-requests/<iid>/head` (a synthetic ref, NOT a real
	 *  branch name) — use mrSourceBranch for the actual MR source branch. */
	readonly ref: string;
	/** Commit sha the pipeline ran for. */
	readonly sha: string;
	/** Project URL (used to derive clone/MR endpoints). */
	readonly projectUrl: string;
	/** MR source branch (only present for merge-request-triggered pipelines).
	 *  This is the real branch name to target with the fix MR — merging the
	 *  fix MR into it updates the source MR's CI. */
	readonly mrSourceBranch?: string;
	/** MR iid (only present for merge-request-triggered pipelines). */
	readonly mrIid?: number;
	/** Stages of the FAILED jobs, from the webhook's builds array (deduped,
	 *  pipeline order). Undefined when the payload carries no builds array —
	 *  consumers must degrade as if nothing is known about the failure stage. */
	readonly failedStages?: readonly string[];
}

/** GitLab merge_request webhook 终局事件（action=merge|close）——触发该 MR 关联的 bot 状态清理。 */
export interface MrTerminalEvent {
	readonly projectId: string;
	readonly mrIid: number;
	readonly action: "merged" | "closed";
}

/** G1 failure root-cause class (v1 only auto-fixes 1/2/3; 4/5 escalate). */
export type FailureClass = 1 | 2 | 3 | 4 | 5;

/** G1 权威类名（playbook diagnosis-detail.md 标题逐字一致；bot 侧上报用）。 */
export const FAILURE_CLASS_NAMES: Readonly<Record<FailureClass, string>> = {
	1: "测试 bug（断言/mock/数据错）",
	2: "被测代码变更导致测试过时",
	3: "缺失测试",
	4: "flaky / 环境问题",
	5: "非单测失败（编译/依赖）",
};

/** 上报统一渲染：class N（类名）；未知数字退化为 class N。 */
export function formatFailureClass(n: number): string {
	const name = FAILURE_CLASS_NAMES[n as FailureClass];
	return name === undefined ? `class ${n}` : `class ${n}（${name}）`;
}

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
			/** Agent 提交的 MR URL（agent 自己 git push + glab mr create）。空 = 未建 MR。 */
			readonly mrUrl?: string;
			readonly metrics?: AgentMetrics;
		/** 实际选中的模型（runner 填充，终局通知上报用）。 */
		readonly model?: AgentModelRef;
	  }
	| {
			readonly kind: "escalated";
			readonly diagnosis: Diagnosis;
			readonly reason: string;
			/** Where the escalation came from: the agent's own structured output
			 *  ("agent") or a bot/runner-generated fallback such as budget exceeded,
			 *  session error, or unparseable output ("runtime"). Only agent-sourced
			 *  escalations may enter the awaiting-decision state (/heal). */
			readonly source: "agent" | "runtime";
			/** Partial-fix MR the agent created before escalating (push + glab
			 *  mr create). Absent when no partial MR was opened. */
			readonly mrUrl?: string;
			readonly metrics?: AgentMetrics;
		/** 实际选中的模型（runner 填充，终局通知上报用）。 */
		readonly model?: AgentModelRef;
	  };

/** Per-session observability metrics (ticket 07). Filled by the runner. */
export interface AgentMetrics {
	/** Number of agent turns in the session. */
	readonly turns: number;
	/** Total tokens consumed across all turns. */
	readonly tokens: number;
}

/** 实际选中的模型（selected candidate）。 */
export interface AgentModelRef {
	readonly provider: string;
	readonly model: string;
	readonly thinkingLevel: string;
}

/** 任务级可观测信息——随终局通知上报（模型/token/耗时/轮数/session 复用）。 */
export interface AgentRunStats {
	/** agent 未运行时缺省（class-5 早筛）。 */
	readonly model?: AgentModelRef;
	readonly turns: number;
	readonly tokens: number;
	readonly cost: number;
	readonly durationMs: number;
	/** ADR-0007：复用了该 pipeline 的存档 session。 */
	readonly reusedFromPipeline?: number;
	/** 诊断失败分类（class 1-5）。 */
	readonly failureClass?: number;
}

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
	| {
			readonly kind: "mr";
			readonly mrUrl: string;
			readonly summary: string;
			/** 任务元信息（模型/token/耗时/轮数/session 复用），终局通知上报用。 */
			readonly agentStats?: AgentRunStats;
	  }
	| {
			readonly kind: "escalated";
			readonly summary: string;
			/** True when this escalation is decidable (agent-initiated with a
			 *  diagnosis): the scene (cwd/worktree/branch) is retained and the main
			 *  process registers a decision awaiting a human /heal reply. */
			readonly decidable?: boolean;
			/** result.diagnosis.summary — carried for the routed decision notification (T04). */
			readonly diagnosisSummary?: string;
			/** Partial-fix MR url (agent created it before escalating); carried
			 *  for the routed notification and the resume context. */
			readonly mrUrl?: string;
			/** 任务元信息（模型/token/耗时/轮数/session 复用），终局通知上报用。 */
			readonly agentStats?: AgentRunStats;
	  }
	| {
			readonly kind: "failed";
			readonly summary: string;
			readonly error: string;
			/** agent 已运行后失败时携带的任务元信息。 */
			readonly agentStats?: AgentRunStats;
	  };
