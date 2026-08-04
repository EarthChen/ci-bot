/**
 * Real agent runner — pi SDK `createAgentSession` integration (ticket 02).
 *
 * Replaces the stub runner with a real pi agent session. Per G2:
 *   - One continuous session: diagnosis → fix → (doc sync) → structured result.
 *   - `/skill:ci-self-heal-playbook` deterministic load + prompt naming (dual safety).
 *   - Budget soft limit: turn_end token accumulation + session.abort() + DingTalk alert.
 *   - Agent NEVER holds the DingTalk tool — only bot code notifies.
 *
 * Test seam: a `sessionFactory` dependency injection. Production passes the real
 * `createAgentSession`; tests pass a stub factory returning a fake session that
 * yields canned diagnosis + fix diff (spec: "fixture 代替 agent，不测实现细节").
 *
 * Per spec: abort fires after turn_end so a single turn may overshoot. Mitigation:
 * an aggressive per-turn token threshold (BOT_BUDGET_TOKENS, default 50k) so the
 * first overshooting turn trips the abort, not the tenth.
 */

import type { AgentResult, Diagnosis } from "../types.js";
import type { AgentRunner, AgentRunInput } from "./runner.js";
import type { DingTalkNotifier } from "../notify/dingtalk.js";
import { logger } from "../util/log.js";
import { join as joinPath } from "node:path";
import { writeFileSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";
import type { AgentSession } from "@earendil-works/pi-coding-agent";
import {
	createAgentSession,
	SessionManager,
	ModelRuntime,
} from "@earendil-works/pi-coding-agent";

/** Budget config for a session. */
export interface BudgetConfig {
	/** Soft cap on total tokens across the whole session. */
	readonly totalTokenLimit: number;
	/** Soft cap on a single turn's tokens (aggressive, to catch overshoot early). */
	readonly perTurnTokenLimit: number;
}

/** Default budget: 200k total / 50k per turn. Tunable via
 * BOT_BUDGET_TOKENS (total) + BOT_BUDGET_PER_TURN_TOKENS (per-turn). */
const DEFAULT_BUDGET: BudgetConfig = {
	totalTokenLimit: 200_000,
	perTurnTokenLimit: 50_000,
};

/** A created session bundle the runner works with. */
export interface SessionBundle {
	readonly session: AgentSession;
	/** Cleanup hook — must dispose the session. */
	readonly dispose: () => void;
}

/** Factory for creating a session bundle (DI seam for tests). */
export type SessionFactory = (input: AgentRunInput) => Promise<SessionBundle>;

/**
 * The default session factory: real `createAgentSession`.
 *
 * - In-memory session (no disk persistence needed; bot owns outcome via result file).
 * - DefaultResourceLoader discovers `.agents/skills/` from cwd (worker isolation).
 * - Model + auth via ModelRuntime (reads env / auth.json per worker's PI_CODING_AGENT_DIR).
 * - Read-only tools: read, grep, find, ls, bash. The agent must READ to diagnose
 *   and run tests, but production writes are gated by G3 (bot-side validateFixPaths).
 *   edit/write are intentionally excluded — the agent outputs a structured fix
 *   diff that bot code applies via glab, never writing files itself.
 */
function defaultSessionFactory(input: AgentRunInput): Promise<SessionBundle> {
	// Lazily constructed per-call so each worker event gets its own ModelRuntime
	// (auth resolved against the worker's PI_CODING_AGENT_DIR env).
	return createDefaultSession(input).then((session) => ({
		session,
		dispose: () => session.dispose(),
	}));
}

async function createDefaultSession(
	input: AgentRunInput,
): Promise<AgentSession> {
	const agentDir = process.env.PI_CODING_AGENT_DIR ?? undefined;
	const modelRuntime = await ModelRuntime.create(
		agentDir
			? {
					authPath: `${agentDir}/auth.json`,
					modelsPath: `${agentDir}/models.json`,
				}
			: {},
	);
	// Inject .env-sourced provider key as a runtime override (not persisted to
	// disk). Falls back to SDK's own env resolution (ANTHROPIC_API_KEY etc.) when
	// MODEL_PROVIDER/MODEL_API_KEY are unset.
	const provider = process.env.MODEL_PROVIDER;
	const apiKey = process.env.MODEL_API_KEY;
	if (provider && apiKey) {
		await modelRuntime.setRuntimeApiKey(provider, apiKey);
	}
	const { session } = await createAgentSession({
		cwd: input.cwd,
		agentDir,
		modelRuntime,
		sessionManager: SessionManager.inMemory(input.cwd),
		tools: ["read", "grep", "find", "ls", "bash"],
	});
	return session;
}

/**
 * Real agent runner backed by the pi SDK.
 *
 * @param sessionFactory  DI seam — tests inject a stub returning canned results.
 * @param dingtalk        Notifier for budget-breached alerts (bot code, not agent).
 * @param budget          Soft token caps. Default 200k total / 50k per turn.
 */
export class RealAgentRunner implements AgentRunner {
	private readonly sessionFactory: SessionFactory;
	private readonly dingtalk: DingTalkNotifier | undefined;
	private readonly budget: BudgetConfig;

	constructor(opts: {
		sessionFactory?: SessionFactory;
		dingtalk?: DingTalkNotifier;
		budget?: Partial<BudgetConfig>;
	}) {
		this.sessionFactory = opts.sessionFactory ?? defaultSessionFactory;
		this.dingtalk = opts.dingtalk;
		this.budget = { ...DEFAULT_BUDGET, ...opts.budget };
	}

	async run(input: AgentRunInput): Promise<AgentResult> {
		const bundle = await this.sessionFactory(input);
		const { session, dispose } = bundle;

		let totalTokens = 0;
		let turnCount = 0;
		let budgetBreached = false;
		let breachReason = "";

		const unsubscribe = session.subscribe((event) => {
			if (event.type !== "turn_end") return;
			turnCount++;
			// turn_end.message is always an assistant message; narrow to read usage.
			const message = event.message as {
				role?: string;
				usage?: { totalTokens: number };
			};
			const usage = message.usage;
			if (!usage) return;
			totalTokens += usage.totalTokens;
			logger.info(
				{
					turnTokens: usage.totalTokens,
					totalTokens,
					limit: this.budget.totalTokenLimit,
				},
				"turn_end budget",
			);
			// Per-turn overshoot: abort this turn's aftermath immediately.
			if (usage.totalTokens > this.budget.perTurnTokenLimit) {
				budgetBreached = true;
				breachReason = `单 turn token ${usage.totalTokens} 超阈值 ${this.budget.perTurnTokenLimit}`;
				void session.abort().catch((err) => {
					logger.warn({ err }, "budget abort failed");
				});
				return;
			}
			// Cumulative overshoot.
			if (totalTokens > this.budget.totalTokenLimit) {
				budgetBreached = true;
				breachReason = `累计 token ${totalTokens} 超阈值 ${this.budget.totalTokenLimit}`;
				void session.abort().catch((err) => {
					logger.warn({ err }, "budget abort failed");
				});
			}
		});

		// Prompt is thin: /skill deterministic load + ref/sha + file paths.
		// CI log + MR diff are written to files in the worker cwd and read via
		// the `read` tool — never inlined into the prompt (large diffs would
		// bloat the turn input and skew token accounting).
		const ciLogPath = joinPath(input.cwd, "ci-log.txt");
		const mrDiffPath = joinPath(input.cwd, "mr-diff.patch");
		await writeText(ciLogPath, input.ciLog);
		if (input.mrDiff) await writeText(mrDiffPath, input.mrDiff);
		const prompt = [
			`/skill:ci-self-heal-playbook`,
			``,
			`# 任务`,
			`分支 ${input.ref} @ ${input.sha.slice(0, 8)} 的 pipeline 单测失败。`,
			``,
			`# 输入文件（用 read 工具读取，不要靠 prompt 里的内容）`,
			`- CI 日志：${ciLogPath}`,
			input.mrDiff ? `- MR diff：${mrDiffPath}` : `- MR diff：无`,
		].join("\n");

		let result: AgentResult;
		try {
			await session.prompt(prompt);
			result = budgetBreached
				? this.escalateBudget(breachReason)
				: this.parseResult(session);
		} catch (err) {
			logger.error({ err }, "agent session failed");
			result = budgetBreached
				? this.escalateBudget(breachReason)
				: this.escalateError(err);
		} finally {
			unsubscribe();
			dispose();
		}

		// Fire budget DingTalk alert after the session is torn down (best-effort).
		if (budgetBreached && this.dingtalk) {
			void this.dingtalk
				.send({
					title: "CI 自愈预算告警",
					text: `项目 ${input.projectId} pipeline ${input.pipelineId} 预算超限：${breachReason}`,
				})
				.catch((err) => logger.warn({ err }, "budget alert failed"));
		}

		return { ...result, metrics: { turns: turnCount, tokens: totalTokens } };
	}

	/** Parse the final assistant message JSON into an AgentResult. */
	private parseResult(session: AgentSession): AgentResult {
		const messages = session.messages;
		// Find the last assistant message with text content.
		let lastText = "";
		for (let i = messages.length - 1; i >= 0; i--) {
			const msg = messages[i];
			if (msg?.role === "assistant") {
				lastText = extractText(msg);
				if (lastText) break;
			}
		}
		if (!lastText) {
			return this.escalateError(new Error("agent produced no assistant text"));
		}
		const parsed = tryParseAgentJson(lastText);
		if (!parsed) {
			return {
				kind: "escalated",
				diagnosis: { failureClass: 4, summary: "agent 未输出合法结构化 JSON" },
				reason: `unparseable result: ${lastText.slice(0, 200)}`,
			};
		}
		return parsed;
	}

	private escalateBudget(reason: string): AgentResult {
		return {
			kind: "escalated",
			diagnosis: { failureClass: 4, summary: `预算超限：${reason}` },
			reason: `budget exceeded: ${reason}`,
		};
	}

	private escalateError(err: unknown): AgentResult {
		const msg = err instanceof Error ? err.message : String(err);
		return {
			kind: "escalated",
			diagnosis: { failureClass: 4, summary: `agent session 异常：${msg}` },
			reason: `agent error: ${msg}`,
		};
	}
}

/** Extract concatenated text content from an AgentMessage (assistant). */
function extractText(msg: { content?: unknown }): string {
	const content = msg.content;
	if (typeof content === "string") return content;
	if (!Array.isArray(content)) return "";
	return content
		.map((block: { type?: string; text?: string }) =>
			block?.type === "text" && typeof block.text === "string"
				? block.text
				: "",
		)
		.join("");
}

/** Parse the JSON block the agent is instructed to output. */
export function tryParseAgentJson(text: string): AgentResult | null {
	// Try the raw text first.
	let candidate = text;
	// Extract from a ```json ... ``` fenced block if present.
	const fenceMatch = text.match(/```(?:json)?\s*\n?([\s\S]*?)\n?```/);
	if (fenceMatch?.[1]) candidate = fenceMatch[1];
	try {
		const obj = JSON.parse(candidate) as Partial<AgentResult>;
		return normalizeAgentResult(obj);
	} catch {
		return null;
	}
}

/** Validate + normalize a parsed object into a well-formed AgentResult. */
function normalizeAgentResult(obj: Partial<AgentResult>): AgentResult | null {
	if (
		obj.kind === "fixed" &&
		obj.diagnosis &&
		typeof obj.summary === "string"
	) {
		const diag = obj.diagnosis as Diagnosis;
		if (
			typeof diag.failureClass === "number" &&
			typeof diag.summary === "string"
		) {
			return { kind: "fixed", diagnosis: diag, summary: obj.summary };
		}
	}
	if (
		obj.kind === "escalated" &&
		obj.diagnosis &&
		typeof obj.reason === "string"
	) {
		const diag = obj.diagnosis as Diagnosis;
		if (
			typeof diag.failureClass === "number" &&
			typeof diag.summary === "string"
		) {
			return { kind: "escalated", diagnosis: diag, reason: obj.reason };
		}
	}
	return null;
}

/** Write a text file, creating parent dirs. Used to spill CI log / MR diff
 * into the worker cwd so the prompt stays thin. */
function writeText(abs: string, content: string): void {
	mkdirSync(dirname(abs), { recursive: true });
	writeFileSync(abs, content, "utf8");
}
