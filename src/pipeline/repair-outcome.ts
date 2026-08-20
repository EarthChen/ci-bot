/**
 * repair-outcome — unified terminal handler for one CI-self-heal repair.
 *
 * Every repair ends in exactly one of three outcomes (mr | escalated | failed).
 * This module concentrates the previously-scattered terminal sequence —
 * notify DingTalk → write G5 audit trace → remove worktree → return
 * RepairOutcome — into a single deep module so the logic lives in one place
 * (locality) and is unit-testable through an injected DingTalkNotifier.
 *
 * Previously `failed` outcomes skipped the audit trace (G5 gap) and worktree
 * cleanup was inconsistent across branches; finishRepair makes both uniform.
 */
import type { DingTalkNotifier } from "../notify/dingtalk.js";
import type {
	AgentModelRef,
	AgentRunStats,
	FailureClass,
	PipelineEvent,
	RepairOutcome,
} from "../types.js";
import { FAILURE_CLASS_NAMES } from "../types.js";
import { taskInfoSection } from "../notify/task-info.js";
import { logger } from "../util/log.js";
import { writeFileSync, mkdirSync, appendFileSync, existsSync, readdirSync, statSync, rmSync } from "node:fs";
import { join as joinPath, basename } from "node:path";
import { resolveAuditDir as resolveAuditDirPath } from "../config/paths.js";
import { resolveRetentionPolicy } from "../config/retention.js";
import { findSessionFile } from "../agent/real-runner.js";
import { saveMrSession } from "./mr-session-store.js";
import { sendIpc } from "../dashboard/ipc-types.js";
import { estimateUsageCost, type TokenUsageComponents } from "../util/cost.js";

/**
 * G5 audit record — persisted per repair so a bad fix can be traced back
 * afterward. Written as audit-trace.json in the worker cwd (sidecar pattern,
 * same as glab-mr-creates.json / dingtalk-sent.json) so the e2e test observes
 * it across the process seam. Production deployment ships these to log/object
 * storage (ticket 07 evolution seam).
 */
export interface AuditTrace {
	/** The pipeline event this repair handled (ties a trace to a pipeline). */
	readonly event: {
		readonly projectId: string;
		readonly pipelineId: number;
		readonly ref: string;
		readonly sha: string;
	};
	/** Repair outcome: "mr" | "escalated" | "failed". */
	readonly outcome: string;
	/** LLM diagnosis (failure class + root-cause summary); absent for class-5. */
	readonly diagnosis?: {
		readonly failureClass: number;
		readonly summary: string;
	};
	/** Real git diff (authoritative; empty for escalations with no patch). */
	readonly diff: string;
	/** The bot's recorded rationale for the outcome (fix summary or escalation reason). */
	readonly reasoning: string;
	/** MR url when outcome === "mr"; absent otherwise. */
	readonly mrUrl?: string;
	/** ISO timestamp for audit ordering / retention. */
	readonly createdAt: string;
	/** Ticket 07: agent turns (0 for class-5 early-filter, no agent). */
	readonly turns: number;
	/** Ticket 07: total tokens consumed (0 for class-5 early-filter, no agent). */
	readonly tokens: number;
	/** Ticket 07: estimated cost = tokens × unit price. */
	readonly cost: number;
	/** Ticket 07: repair wall-clock duration in ms. */
	readonly durationMs: number;
	/** T06: set on resume runs — the decision that triggered this resume. */
	readonly decisionId?: string;
	/** T06: intervention chain depth (1 = first resume round). */
	readonly chainDepth?: number;
	/** Run-6 缺口修复：escalated 终局前 agent 已改动的文件清单（非可决策
	 *  转交清理现场后，diff 为空，此清单是本地唯一改动记录）。 */
	readonly sceneChanges?: readonly string[];
	/** ADR-0007：本次修复复用了该 pipeline 的 session（跨 pipeline 复用可追溯）。 */
	readonly reusedFromPipeline?: number;
	/** G1 类名（bot-owned 静态映射）——audit/metrics 可读性，与 diagnosis.failureClass 同源。 */
	readonly classDescription?: string;
	/** G3 扩围（ADR-0009）：widenable 转交冻入的 MR diff 外文件清单（决策与审计可追溯）。 */
	readonly oosPaths?: readonly string[];
}

/** Metrics slice embedded in an audit trace. */
export interface RepairMetrics {
	readonly turns: number;
	readonly tokens: number;
	/** 分量 usage（计价口径）；降级路径可缺省，cost 已按分量折算。 */
	readonly usage?: TokenUsageComponents;
	readonly cost: number;
	readonly durationMs: number;
}

/** Compute the estimated cost for a usage breakdown (分量计价, see util/cost). */
export function repairCost(usage: TokenUsageComponents): number {
	return estimateUsageCost(usage);
}

/** Zero metrics (for paths that never run the agent, e.g. class-5 early filter). */
const ZERO_METRICS: RepairMetrics = {
	turns: 0,
	tokens: 0,
	cost: 0,
	durationMs: 0,
};

/** A repair's terminal result, handed to finishRepair. */
export interface RepairResult {
	readonly kind: "mr" | "escalated" | "failed";
	/** Success summary / escalation reason / failure stage. */
	readonly summary: string;
	/** LLM diagnosis, when an agent ran and produced one. */
	readonly diagnosis?: AuditTrace["diagnosis"];
	/** Real git diff (authored by the patch extractor), when present. */
	readonly diff?: string;
	/** MR url — the fix MR (outcome "mr") or a partial-fix MR on escalation. */
	readonly mrUrl?: string;
	/** Agent metrics; defaults to ZERO_METRICS for failed / class-5. */
	readonly metrics?: RepairMetrics;
	/** Error detail for failed outcomes. */
	readonly error?: string;
	/** Escalated-only: agent-initiated escalation with diagnosis — retain the
	 *  scene (skip worktree cleanup) and flag the outcome as decidable. */
	readonly decidable?: boolean;
	/** Escalated-only：agent 转交前已改动的文件清单（入审计）。 */
	readonly sceneChanges?: readonly string[];
	/** G3 扩围（ADR-0009）：widenable 转交携带的 MR diff 外测试/文档文件清单。 */
	readonly oosPaths?: readonly string[];
	/** 实际选中的模型（runner 填充；终局通知任务信息上报）。 */
	readonly model?: AgentModelRef;
}

/** Serialize one audit trace to its metric JSONL line. */
export function metricLine(trace: AuditTrace): string {
	return JSON.stringify({
		projectId: trace.event.projectId,
		pipelineId: trace.event.pipelineId,
		outcome: trace.outcome,
		turns: trace.turns,
		tokens: trace.tokens,
		cost: trace.cost,
		durationMs: trace.durationMs,
		createdAt: trace.createdAt,
	});
}

/** Resolve the durable audit directory (survives per-event cwd deletion). */
export function resolveAuditDir(): string {
	return resolveAuditDirPath();
}

/**
 * Passive audit cleanup: drop per-pipeline buckets whose last write is older
 * than retention.audit.maxAgeDays. Runs opportunistically inside
 * persistDurable (best-effort, never throws into the write path).
 */
function pruneAudit(): void {
	try {
		const dir = resolveAuditDir();
		if (!existsSync(dir)) return;
		const maxAgeDays = resolveRetentionPolicy().audit.maxAgeDays;
		const cutoff = Date.now() - maxAgeDays * 24 * 60 * 60 * 1000;
		for (const e of readdirSync(dir)) {
			try {
				const bucket = joinPath(dir, e);
				if (statSync(bucket).mtimeMs < cutoff)
					rmSync(bucket, { recursive: true, force: true });
			} catch {
				// best-effort
			}
		}
	} catch {
		// retention policy unreadable or dir missing — skip this pass.
	}
}

/** Write the audit trace sidecar to the worker cwd (best-effort, never throws). */
function writeAuditTrace(cwd: string, trace: AuditTrace): void {
	try {
		mkdirSync(cwd, { recursive: true });
		writeFileSync(
			joinPath(cwd, "audit-trace.json"),
			JSON.stringify(trace, null, 2),
			"utf8",
		);
	} catch (err) {
		logger.warn({ cwd, err }, "audit-trace write failed");
	}
	// Ticket 07: also append one JSONL line to metrics.jsonl so aggregate
	// stats (success rate / avg repair time / cost / count) can be derived
	// without an external metrics store. v1 file-based (G7: no external deps);
	// production ships lines to a metrics pipeline (Prometheus evolution seam).
	appendMetric(cwd, trace);
	// Durable copy: persist to <CIHEAL_DATA_ROOT>/audit so the trace survives cwd
	// cleanup (ticket 07 evolution seam — production ships to object storage).
	// Bucketed by pipelineId; the run file is named by the per-event worktree
	// id (basename(cwd)) so re-runs never overwrite a prior attempt.
	persistDurable(cwd, trace);
}

/** Persist the audit trace + metric to the durable audit dir (best-effort). */
export function persistDurable(cwd: string, trace: AuditTrace): void {
	try {
		pruneAudit();
		const dir = joinPath(resolveAuditDir(), String(trace.event.pipelineId));
		mkdirSync(dir, { recursive: true });
		const runId = basename(cwd);
		writeFileSync(
			joinPath(dir, `${runId}-audit-trace.json`),
			JSON.stringify(trace, null, 2),
			"utf8",
		);
		appendFileSync(joinPath(dir, "metrics.jsonl"), metricLine(trace) + "\n", "utf8");
	} catch (err) {
		logger.warn(
			{ pipelineId: trace.event.pipelineId, runId: basename(cwd), err },
			"durable audit write failed",
		);
	}
}

/** Append one metric line to metrics.jsonl (best-effort). */
export function appendMetric(cwd: string, trace: AuditTrace): void {
	try {
		appendFileSync(joinPath(cwd, "metrics.jsonl"), metricLine(trace) + "\n", "utf8");
	} catch (err) {
		logger.warn({ cwd, err }, "metrics append failed");
	}
}

/** Build the event slice of an audit trace. */
function auditEvent(event: PipelineEvent): AuditTrace["event"] {
	return {
		projectId: event.projectId,
		pipelineId: event.pipelineId,
		ref: event.ref,
		sha: event.sha,
	};
}

function shortSha(sha: string): string {
	return sha.slice(0, 8);
}

function notifySuccess(
	dingtalk: DingTalkNotifier,
	event: PipelineEvent,
	mrUrl: string,
	summary: string,
	stats?: AgentRunStats,
): Promise<void> {
	return dingtalk.send({
		title: "CI 自愈修复成功",
		text: [
			"### ✅ CI 自愈修复成功",
			"",
			"**任务**",
			`- 项目：${event.projectId}`,
			`- 分支：${event.ref} @ ${shortSha(event.sha)}`,
			"",
			"**结论**",
			`- 诊断：${summary}`,
			"",
			"**成果**",
			`- MR：${mrUrl}`,
			"",
			...taskInfoSection(stats),
		].join("\n"),
	});
}

function notifyFailure(
	dingtalk: DingTalkNotifier,
	event: PipelineEvent,
	stage: string,
	error: string,
	stats?: AgentRunStats,
): Promise<void> {
	const message = [
		`项目 ${event.projectId} pipeline ${event.pipelineId} 在 ${stage} 阶段失败：${error}`,
		...taskInfoSection(stats),
	].join("\n");
	return dingtalk
		.send({ title: "CI 自愈 Bot 异常", text: message })
		.catch((notifyErr) => {
			logger.warn({ event, stage, notifyErr }, "failure-notify failed");
		});
}

/**
 * Unified terminal handler for a repair.
 *
 * Always: notify (success / escalation / failure) → write G5 audit trace →
 * best-effort remove worktree → return RepairOutcome. `failed` outcomes now
 * also write an audit trace (previously skipped) and worktree cleanup is
 * uniform across every branch.
 */
export async function finishRepair(args: {
	dingtalk: DingTalkNotifier;
	cwd: string;
	event: PipelineEvent;
	result: RepairResult;
	/** Injected worktree cleanup seam (best-effort). */
	removeWorktree: (cwd: string) => Promise<void>;
	/** T06: resume-run audit context (decision chain) threaded into the trace. */
	audit?: { readonly decisionId?: string; readonly chainDepth?: number; readonly reusedFromPipeline?: number };
}): Promise<RepairOutcome> {
	const { dingtalk, cwd, event, result, removeWorktree, audit } = args;
	const metrics = result.metrics ?? ZERO_METRICS;
	// 任务元信息（模型/token/耗时/轮数/session 复用/失败分类）→ 终局通知。
	// agent 未运行的路径（class-5 早筛等）无 metrics/model → 不上报。
	const agentStats: AgentRunStats | undefined =
		result.metrics || result.model
			? {
					...(result.model ? { model: result.model } : {}),
					...metrics,
					...(audit?.reusedFromPipeline != null
						? { reusedFromPipeline: audit.reusedFromPipeline }
						: {}),
					...(result.diagnosis
						? { failureClass: result.diagnosis.failureClass }
						: {}),
				}
			: undefined;
	const diff = result.diff ?? "";
	const reasoning =
		result.kind === "failed"
			? `${result.summary} 阶段失败：${result.error ?? ""}`
			: (result.error ?? result.summary);
	const summary = result.diagnosis?.summary ?? result.summary;

	// escalated notifications moved to the main-process routed notifier (T04);
	// the worker only reports the outcome (mr success / failed still notify here).
	if (result.kind === "mr") {
		await notifySuccess(dingtalk, event, result.mrUrl ?? "", summary, agentStats);
	} else if (result.kind === "failed") {
		logger.error(
			{ event, stage: result.summary, error: result.error },
			"repair failed",
		);
		await notifyFailure(dingtalk, event, result.summary, result.error ?? "", agentStats);
	}


	// ADR-0007：带 MR 成果的终局存档 session（跨 pipeline 复用）。session
	// 住在 <cwd>/.pi-agent/sessions/（worker 约定），接下来的现场清理会销毁它。
	// best-effort：stub 模式/早败路径无 session，绝不阻断终局处理。
	if (result.kind === "mr" || (result.kind === "escalated" && result.mrUrl)) {
		let sessionFile: string | null = null;
		try {
			sessionFile = findSessionFile(joinPath(cwd, ".pi-agent"));
		} catch {
			sessionFile = null;
		}
		if (sessionFile) saveMrSession(event, sessionFile, result.kind);
	}
	const createdAt = new Date().toISOString();
	writeAuditTrace(cwd, {
		event: auditEvent(event),
		outcome: result.kind,
		diagnosis: result.diagnosis,
		...(result.diagnosis
			? { classDescription: FAILURE_CLASS_NAMES[result.diagnosis.failureClass as FailureClass] }
			: {}),
		...(result.oosPaths?.length ? { oosPaths: result.oosPaths } : {}),
		diff,
		reasoning,
		mrUrl: result.mrUrl,
		...(result.sceneChanges?.length
			? { sceneChanges: result.sceneChanges }
			: {}),
		createdAt,
		...metrics,
		...(audit ?? {}),
	});

	sendIpc({
		type: "metrics_record",
		projectId: event.projectId,
		pipelineId: event.pipelineId,
		outcome: result.kind,
		turns: metrics.turns,
		tokens: metrics.tokens,
		cost: metrics.cost,
		durationMs: metrics.durationMs,
		createdAt,
	});

	// Scene retention: a decidable escalation keeps the worktree + cwd so a
	// human decision can resume the session later (T03). Everything else is
	// cleaned up as before.
	if (!(result.kind === "escalated" && result.decidable)) {
		await removeWorktree(cwd).catch(() => {});
	}

	if (result.kind === "mr") {
		return {
			kind: "mr",
			mrUrl: result.mrUrl ?? "",
			summary,
			...(agentStats ? { agentStats } : {}),
		};
	}
	if (result.kind === "escalated") {
		const mrUrl = result.mrUrl ? { mrUrl: result.mrUrl } : {};
		if (result.decidable) {
			return {
				kind: "escalated",
				summary: result.summary,
				decidable: true,
				diagnosisSummary: result.diagnosis?.summary,
				...mrUrl,
				...(result.oosPaths?.length ? { oosPaths: result.oosPaths } : {}),
				...(agentStats ? { agentStats } : {}),
			};
		}
		return {
			kind: "escalated",
			summary: result.summary,
			...mrUrl,
			...(agentStats ? { agentStats } : {}),
		};
	}
	return {
		kind: "failed",
		summary: `${result.summary} failed`,
		error: result.error ?? "",
		...(agentStats ? { agentStats } : {}),
	};
}
