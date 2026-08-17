/**
 * Real agent runner — CI Repair Vertical Agent backed by the shared runtime.
 *
 * Delegates Pi session lifecycle, budget monitoring, and execution to
 * `SharedAgentRuntime`. Retains CI-specific responsibilities:
 *   - Structured AgentResult parsing (failureClass validation)
 *   - Budget DingTalk alerts
 *   - Error message sanitization
 *
 * Test seam: `sessionFactory` DI (unchanged from ticket 02).
 */

import type { AgentResult } from "../types.js";
import type { AgentRunner, AgentRunInput } from "./runner.js";
import type { DingTalkNotifier } from "../notify/dingtalk.js";
import { logger } from "../util/log.js";
import { join as joinPath } from "node:path";
import { existsSync, writeFileSync } from "node:fs";
import type { AgentSession } from "@earendil-works/pi-coding-agent";
import type {
	BudgetConfig,
	RuntimeSessionBundle,
} from "../agent-runtime/runtime.js";
import { SharedAgentRuntime } from "../agent-runtime/runtime.js";
import { createCiRepairDefinition, buildContinuePrompt } from "./ci-repair-definition.js";
import { tryParseAgentJson } from "../agents/ci-repair/result-parser.js";

// Re-export for backward compatibility
export type { BudgetConfig };

/** Factory for creating a session bundle (DI seam for tests). */
export type SessionFactory = (
	input: AgentRunInput,
) => Promise<RuntimeSessionBundle>;

/**
 * Real agent runner backed by the shared Pi Agent Runtime.
 *
 * @param sessionFactory  DI seam — tests inject a stub returning canned results.
 * @param dingtalk        Notifier for budget-breached alerts (bot code, not agent).
 * @param budget          Soft token caps. Default 200k total / 50k per turn.
 */
export class RealAgentRunner implements AgentRunner {
	private readonly sessionFactory: SessionFactory;
	private readonly dingtalk: DingTalkNotifier | undefined;
	private readonly budget: Partial<BudgetConfig>;
	/** Open session held across a retry loop (reused via continue()). */
	private activeSession: AgentSession | undefined;
	private activeDispose: (() => void) | undefined;

	constructor(opts: {
		sessionFactory?: SessionFactory;
		dingtalk?: DingTalkNotifier;
		budget?: Partial<BudgetConfig>;
	}) {
		this.sessionFactory = opts.sessionFactory ?? defaultSessionFactory;
		this.dingtalk = opts.dingtalk;
		this.budget = opts.budget ?? {};
	}

	async run(input: AgentRunInput): Promise<AgentResult> {
		const ciFactory = this.sessionFactory;
		const runtime = new SharedAgentRuntime({
			sessionFactory: async () => ciFactory(input),
			budget: this.budget,
		});

		const definition = createCiRepairDefinition(input.cwd);
		const opened = await runtime.runSession({ definition, input, cwd: input.cwd });
		this.activeSession = opened.session;
		this.activeDispose = opened.dispose;

		let agentResult: AgentResult;
		switch (opened.result.status) {
			case "completed":
				agentResult = this.parseResult(opened.result.finalText);
				break;
			case "budget_exceeded":
				agentResult = this.escalateBudget(opened.result.reason);
				break;
			case "failed":
				agentResult = this.escalateError(
					new Error(`session ${opened.result.failure}`),
				);
				break;
		}

		// Fire budget DingTalk alert after the session is torn down (best-effort).
		if (opened.result.status === "budget_exceeded" && this.dingtalk) {
			void this.dingtalk
				.send({
				title: "CI 自愈预算告警",
				text: `项目 ${input.projectId} pipeline ${input.pipelineId} 预算超限：${opened.result.reason}`,
			})
				.catch((err) => logger.warn({ err }, "budget alert failed"));
		}

		return { ...agentResult, metrics: opened.result.metrics };
	}

	async continue(
		input: AgentRunInput,
		priorMrUrl: string,
		newCiLog: string,
	): Promise<AgentResult> {
		if (!this.activeSession) {
			return this.escalateError(new Error("no open session to continue"));
		}
		const prompt = buildContinuePrompt(input, priorMrUrl, newCiLog);
		const runtime = new SharedAgentRuntime({
			sessionFactory: async () => this.sessionFactory(input),
			budget: this.budget,
		});
		const result = await runtime.continueSession(this.activeSession, prompt);

		let agentResult: AgentResult;
		switch (result.status) {
			case "completed":
				agentResult = this.parseResult(result.finalText);
				break;
			case "budget_exceeded":
				agentResult = this.escalateBudget(result.reason);
				break;
			case "failed":
				agentResult = this.escalateError(
					new Error(`session ${result.failure}`),
				);
				break;
		}

		if (result.status === "budget_exceeded" && this.dingtalk) {
			void this.dingtalk
				.send({
				title: "CI 自愈预算告警",
				text: `项目 ${input.projectId} pipeline ${input.pipelineId} 重试预算超限：${result.reason}`,
			})
				.catch((err) => logger.warn({ err }, "budget alert failed"));
		}

		return { ...agentResult, metrics: result.metrics };
	}

	close(): void {
		this.activeDispose?.();
		this.activeSession = undefined;
		this.activeDispose = undefined;
	}

	/** Parse the final assistant text JSON into an AgentResult. */
	private parseResult(text: string): AgentResult {
		if (!text) {
			return this.escalateError(new Error("agent produced no assistant text"));
		}
		const parsed = tryParseAgentJson(text);
		if (!parsed) {
			return {
				kind: "escalated",
				diagnosis: { failureClass: 4, summary: "agent 未输出合法结构化 JSON" },
				reason: `unparseable result: ${text.slice(0, 200)}`,
				source: "runtime",
			};
		}
		return parsed;
	}

	private escalateBudget(reason: string): AgentResult {
		return {
			kind: "escalated",
			diagnosis: { failureClass: 4, summary: `预算超限：${reason}` },
			reason: `budget exceeded: ${reason}`,
			source: "runtime",
		};
	}

	private escalateError(err: unknown): AgentResult {
		const message = safeExternalErrorMessage(err);
		return {
			kind: "escalated",
			diagnosis: { failureClass: 4, summary: `agent session 异常：${message}` },
			reason: `agent error: ${message}`,
			source: "runtime",
		};
	}
}

/** The default session factory: real `createAgentSession`.
 *
 * Creates the CI Repair definition and passes its resources into the session.
 */
async function defaultSessionFactory(
	input: AgentRunInput,
): Promise<RuntimeSessionBundle> {
	const definition = createCiRepairDefinition(input.cwd);
	const session = await createDefaultSession(input, definition);
	return {
		session,
		// P1-3: 持久化完整 agent session messages 到审计目录（完整 jsonl，用于审计/排查）。
		// 写到 CIHEAL_WORKER_LOG_DIR（审计目录，不在 worktree cwd，不被 cleanup 删除）。
		// session.messages 在 dispose 时完整（含所有 user/assistant/tool_use/tool_result），
		// 比运行时 subscribe 简化版更完整、更可靠（无需猜测 event 结构、不截断）。
		dispose: () => {
			const workerLogDir = process.env.CIHEAL_WORKER_LOG_DIR;
			if (workerLogDir) {
				try {
					const lines = session.messages.map((m) => JSON.stringify(m));
					writeFileSync(
						joinPath(workerLogDir, "agent-session.jsonl"),
						lines.join("\n") + "\n",
					);
				} catch {
					// best-effort：磁盘/权限问题不阻塞 agent
				}
			}
			session.dispose();
		},
	};
}

async function createDefaultSession(
	input: AgentRunInput,
	definition: import("../agent-runtime/runtime.js").AgentDefinition<AgentRunInput>,
): Promise<AgentSession> {
	const {
		createAgentSession,
		DefaultResourceLoader,
		SessionManager,
		SettingsManager,
		ModelRuntime,
	} = await import("@earendil-works/pi-coding-agent");
	const { loadModelCandidates, selectModelCandidate } = await import(
		"./model-selection.js"
	);

	const agentDir = process.env.PI_CODING_AGENT_DIR;
	if (!agentDir) {
		throw new Error("PI_CODING_AGENT_DIR is required for an isolated worker");
	}
	const modelRuntime = await ModelRuntime.create({
		authPath: `${agentDir}/auth.json`,
		modelsPath: `${agentDir}/models.json`,
	});
	const botRoot = resolveBotRoot();
	const configDir = joinPath(botRoot, "config");
	const selected = await selectModelCandidate(
		modelRuntime,
		loadModelCandidates(joinPath(configDir, "model-candidates.json")),
	);
	const candidate = selected.candidate;

	// The worker owns Pi resources. Do not discover settings, extensions, skills,
	// prompts, themes, or context files from the target repository worktree.
	const settingsManager = SettingsManager.create(botRoot, agentDir);
	settingsManager.applyOverrides({
		defaultThinkingLevel: candidate.defaultThinkingLevel,
		...(candidate.compaction ? { compaction: candidate.compaction } : {}),
	});
	const resourceLoader = new DefaultResourceLoader({
		cwd: input.cwd,
		agentDir,
		settingsManager,
		noExtensions: true,
		noSkills: true,
		noPromptTemplates: true,
		noThemes: true,
		noContextFiles: true,
		additionalSkillPaths: [...definition.resources.skillPaths],
		// Keep Pi's built-in tool guidance; target worktree SYSTEM.md is not trusted.
		systemPromptOverride: () => undefined,
		appendSystemPrompt: [definition.resources.appendSystemPromptPath],
	});
	await resourceLoader.reload();

	const { session } = await createAgentSession({
		cwd: input.cwd,
		agentDir,
		model: selected.model,
		thinkingLevel: candidate.defaultThinkingLevel,
		modelRuntime,
		resourceLoader,
		settingsManager,
		sessionManager: SessionManager.inMemory(input.cwd),
		tools: ["read", "grep", "find", "ls", "bash"],
	});

	return session;
}

/** Resolve the trusted bot release root; never derive it from a target worktree. */
function resolveBotRoot(): string {
	const botRoot = process.env.CIHEAL_BOT_ROOT;
	if (!botRoot)
		throw new Error("CIHEAL_BOT_ROOT is required for bot-owned resources");
	if (!existsSync(joinPath(botRoot, "config"))) {
		throw new Error("CIHEAL_BOT_ROOT does not contain config");
	}
	return botRoot;
}

/** Keep provider responses and credential details out of MR and DingTalk output. */
function safeExternalErrorMessage(err: unknown): string {
	const message = err instanceof Error ? err.message : "unknown error";
	if (message.includes("no available model candidate")) {
		return "没有可用的模型候选";
	}
	if (message.includes("PI_CODING_AGENT_DIR")) return "worker 配置目录缺失";
	if (message.includes("CIHEAL_BOT_ROOT")) return "bot 发布配置缺失";
	return "agent 运行失败；详情见服务日志";
}
