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
import type { PipelineEvent, RepairOutcome } from "../types.js";
import { logger } from "../util/log.js";
import { writeFileSync, mkdirSync, appendFileSync } from "node:fs";
import { join as joinPath, basename } from "node:path";

/**
 * G5 audit record — persisted per repair so a bad fix can be traced back
 * afterward. Written as audit-trace.json in the worker cwd (sidecar pattern,
 * same as glab-mr-creates.json / dingtalk-sent.json) so the e2e test observes
 * it across the process seam. Production deployment ships these to log/object
 * storage (ticket 07 evolution seam).
 */
interface AuditTrace {
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
}

/** Metrics slice embedded in an audit trace. */
export interface RepairMetrics {
	readonly turns: number;
	readonly tokens: number;
	readonly cost: number;
	readonly durationMs: number;
}

const COST_PER_1K_TOKENS = Number(
	process.env.BOT_TOKEN_UNIT_COST_PER_1K ?? "0.001",
);

/** Compute the estimated cost for a token count. */
export function repairCost(tokens: number): number {
	return (
		Math.round((tokens / 1000) * COST_PER_1K_TOKENS * 1_000_000) / 1_000_000
	);
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
	/** MR url, when outcome === "mr". */
	readonly mrUrl?: string;
	/** Agent metrics; defaults to ZERO_METRICS for failed / class-5. */
	readonly metrics?: RepairMetrics;
	/** Error detail for failed outcomes. */
	readonly error?: string;
}

/** Serialize one audit trace to its metric JSONL line. */
export function metricLine(trace: AuditTrace): string {
	return JSON.stringify({
		projectId: trace.event.projectId,
		pipelineId: trace.event.pipelineId,
		outcome: trace.outcome,
		tokens: trace.tokens,
		cost: trace.cost,
		durationMs: trace.durationMs,
		createdAt: trace.createdAt,
	});
}

/** Resolve the durable audit directory (survives per-event cwd deletion). */
export function resolveAuditDir(): string {
	const base =
		process.env.CIHEAL_AUDIT_DIR ??
		joinPath(process.env.CIHEAL_BOT_ROOT ?? process.cwd(), ".audit");
	return base;
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
	// Durable copy: persist to CIHEAL_AUDIT_DIR so the trace survives cwd
	// cleanup (ticket 07 evolution seam — production ships to object storage).
	// Bucketed by pipelineId; the run file is named by the per-event worktree
	// id (basename(cwd)) so re-runs never overwrite a prior attempt.
	persistDurable(cwd, trace);
}

/** Persist the audit trace + metric to the durable audit dir (best-effort). */
export function persistDurable(cwd: string, trace: AuditTrace): void {
	try {
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

function notifyFailure(
	dingtalk: DingTalkNotifier,
	event: PipelineEvent,
	stage: string,
	error: string,
): Promise<void> {
	const message = `项目 ${event.projectId} pipeline ${event.pipelineId} 在 ${stage} 阶段失败：${error}`;
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
}): Promise<RepairOutcome> {
	const { dingtalk, cwd, event, result, removeWorktree } = args;
	const metrics = result.metrics ?? ZERO_METRICS;
	const diff = result.diff ?? "";
	const reasoning =
		result.kind === "failed"
			? `${result.summary} 阶段失败：${result.error ?? ""}`
			: (result.error ?? result.summary);
	const summary = result.diagnosis?.summary ?? result.summary;

	if (result.kind === "mr") {
		await notifySuccess(dingtalk, event, result.mrUrl ?? "", summary);
	} else if (result.kind === "escalated") {
		await notifyEscalation(dingtalk, event, result.summary);
	} else {
		logger.error(
			{ event, stage: result.summary, error: result.error },
			"repair failed",
		);
		await notifyFailure(dingtalk, event, result.summary, result.error ?? "");
	}

	writeAuditTrace(cwd, {
		event: auditEvent(event),
		outcome: result.kind,
		diagnosis: result.diagnosis,
		diff,
		reasoning,
		mrUrl: result.mrUrl,
		createdAt: new Date().toISOString(),
		...metrics,
	});

	await removeWorktree(cwd).catch(() => {});

	if (result.kind === "mr") {
		return { kind: "mr", mrUrl: result.mrUrl ?? "", summary };
	}
	if (result.kind === "escalated") {
		return { kind: "escalated", summary: result.summary };
	}
	return {
		kind: "failed",
		summary: `${result.summary} failed`,
		error: result.error ?? "",
	};
}
