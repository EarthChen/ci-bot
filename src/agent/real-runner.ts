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

import type { AgentModelRef, AgentResult } from "../types.js";
import type { AgentRunner, AgentRunInput, ResumeDecision } from "./runner.js";
import type { DingTalkNotifier } from "../notify/dingtalk.js";
import { logger } from "../util/log.js";
import { join as joinPath } from "node:path";
import { existsSync, readdirSync, statSync, writeFileSync } from "node:fs";
import type { AgentSession } from "@earendil-works/pi-coding-agent";
import type {
	BudgetConfig,
	RuntimeSessionBundle,
} from "../agent-runtime/runtime.js";
import { SharedAgentRuntime } from "../agent-runtime/runtime.js";
import { createCiRepairDefinition, createCiResumeDefinition, buildContinuePrompt } from "./ci-repair-definition.js";
import { tryParseAgentJson } from "../agents/ci-repair/result-parser.js";

// Re-export for backward compatibility
export type { BudgetConfig };

/** Factory for creating a session bundle (DI seam for tests). */
export type SessionFactory = (
	input: AgentRunInput,
	/** T06: set on resume — re-open this retained session file instead of a fresh session. */
	resume?: { readonly sessionFile: string; readonly compactForReuse?: boolean },
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
	/** 当前 session 选中的模型（continue 复用同一 session → 同一模型）。 */
	private activeModelInfo: AgentModelRef | undefined;

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
			sessionFactory: async () =>
				ciFactory(
					input,
					input.reuseSessionFile
						? { sessionFile: input.reuseSessionFile, compactForReuse: true }
						: undefined,
				),
			budget: this.budget,
		});

		const definition = createCiRepairDefinition(input.cwd);
		const opened = await runtime.runSession({ definition, input, cwd: input.cwd });
		this.activeSession = opened.session;
		this.activeDispose = opened.dispose;
		this.activeModelInfo = opened.modelInfo;

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

		return {
			...agentResult,
			metrics: opened.result.metrics,
			...(opened.modelInfo ? { model: opened.modelInfo } : {}),
		};
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

		return {
			...agentResult,
			metrics: result.metrics,
			...(this.activeModelInfo ? { model: this.activeModelInfo } : {}),
		};
	}

	close(): void {
		this.activeDispose?.();
		this.activeSession = undefined;
		this.activeDispose = undefined;
		this.activeModelInfo = undefined;
	}

	/**
	 * Resume a retained escalation after a human decision (T06). Re-opens the
	 * retained session (fail loud when missing — never silently start fresh),
	 * injects the decision prompt as a new user message, and runs with a FRESH
	 * budget (this runner instance is fresh per resume worker).
	 */
	async resume(
		input: AgentRunInput,
		decision: ResumeDecision,
	): Promise<AgentResult> {
		let sessionFile: string;
		try {
			sessionFile = findSessionFile(process.env.PI_CODING_AGENT_DIR ?? "");
		} catch (err) {
			return this.escalateError(err);
		}
		const ciFactory = this.sessionFactory;
		const runtime = new SharedAgentRuntime({
			sessionFactory: async () => ciFactory(input, { sessionFile }),
			budget: this.budget,
		});
		const definition = createCiResumeDefinition(input.cwd, decision);
		const opened = await runtime.runSession({
			definition,
			input,
			cwd: input.cwd,
		});
		this.activeSession = opened.session;
		this.activeDispose = opened.dispose;
		this.activeModelInfo = opened.modelInfo;

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

		if (opened.result.status === "budget_exceeded" && this.dingtalk) {
			void this.dingtalk
				.send({
					title: "CI 自愈预算告警",
					text: `项目 ${input.projectId} pipeline ${input.pipelineId} 恢复预算超限：${opened.result.reason}`,
			})
				.catch((err) => logger.warn({ err }, "budget alert failed"));
		}

		return {
			...agentResult,
			metrics: opened.result.metrics,
			...(opened.modelInfo ? { model: opened.modelInfo } : {}),
		};
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
				reason: `unparseable result: ${summarizeUnparseable(text)}`,
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

/** unparseable 结果的摘要上限：终局上报需要完整诊断上下文
 * （旧 200 字符曾截断 MR !281 的根因描述）；钉钉 markdown 限额远大于此。 */
export const UNPARSEABLE_SUMMARY_CHARS = 1500;

/** 截断 unparseable agent 输出为 reason 摘要（超长带省略号标记）。 */
export function summarizeUnparseable(text: string): string {
	return text.length > UNPARSEABLE_SUMMARY_CHARS
		? `${text.slice(0, UNPARSEABLE_SUMMARY_CHARS)}…`
		: text;
}

/** The default session factory: real `createAgentSession`.
 *
 * Creates the CI Repair definition and passes its resources into the session.
 */
async function defaultSessionFactory(
	input: AgentRunInput,
	resume?: { readonly sessionFile: string; readonly compactForReuse?: boolean },
): Promise<RuntimeSessionBundle> {
	const definition = createCiRepairDefinition(input.cwd);
	const { session, modelInfo } = await createDefaultSession(input, definition, resume?.sessionFile, resume?.compactForReuse);
	return {
		session,
		modelInfo,
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
	/** T06: re-open a retained session file instead of creating a fresh one. */
	resumeSessionFile?: string,
	/** ADR-0007: 跨 pipeline 存档重开时先 compact（best-effort，失败降级不压缩）。 */
	compactForReuse?: boolean,
): Promise<{ session: AgentSession; modelInfo: AgentModelRef }> {
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
		// Bot-owned pi package：显式路径加载，noExtensions 保持 true（worktree/用户目录发现仍禁用）。
		additionalExtensionPaths: [cacheOptimizerExtensionPath(botRoot)],
		// Keep Pi's built-in tool guidance; target worktree SYSTEM.md is not trusted.
		systemPromptOverride: () => undefined,
		appendSystemPrompt: [definition.resources.appendSystemPromptPath],
	});
	await resourceLoader.reload();

	// T06 / ADR-0007：复用 = 重开存档/保留 session，否则新建。
	const sessionManager = resumeSessionFile
		? SessionManager.open(resumeSessionFile)
		: SessionManager.create(input.cwd);

	const { session } = await createAgentSession({
		cwd: input.cwd,
		agentDir,
		model: selected.model,
		thinkingLevel: candidate.defaultThinkingLevel,
		modelRuntime,
		resourceLoader,
		settingsManager,
		// T06: sessions are PERSISTED (create, not inMemory) so a retained scene
		// carries its jsonl under <agentDir>/sessions/ for a later /heal resume.
		// Resume re-opens the exact retained session file.
		sessionManager,
		tools: ["read", "grep", "find", "ls", "bash"],
	});

	// ADR-0007：跨 pipeline 复用在继续前先 compact（AgentSession.compact 即
	// /compact 的编程接口，一次摘要调用把旧上下文压成 summary + keepRecent）。
	// best-effort：失败降级为不压缩继续，绝不阻断修复。
	if (resumeSessionFile && compactForReuse) {
		try {
			const compacted = await session.compact(
				"为跨 pipeline 复用总结本次 CI 修复会话：保留仓库结构/构建命令/根因与修复结论，并注明哪些结论仅适用于旧 commit",
			);
			logger.info(
				{ tokensBefore: compacted.tokensBefore, pipelineId: input.pipelineId },
				"session compacted for cross-pipeline reuse",
			);
		} catch (err) {
			logger.warn({ err }, "reuse compaction failed — continuing uncompacted");
		}
	}

	return {
		session,
		modelInfo: {
			provider: candidate.provider,
			model: candidate.model,
			thinkingLevel: candidate.defaultThinkingLevel,
		},
	};
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

/** Bot-owned pi package 扩展（`pi install -l` 装到 <botRoot>/.pi/npm）。
 *  显式路径 + noExtensions:true = 只加载这一个 bot-owned 文件，worktree 发现保持禁用。 */
const CACHE_OPTIMIZER_EXTENSION = ".pi/npm/node_modules/pi-cache-optimizer/index.ts";

function cacheOptimizerExtensionPath(botRoot: string): string {
	const extensionPath = joinPath(botRoot, CACHE_OPTIMIZER_EXTENSION);
	if (!existsSync(extensionPath)) {
		logger.warn(
			{ path: extensionPath },
			"pi-cache-optimizer extension missing — cache optimization disabled",
		);
	}
	return extensionPath;
}

/** Keep provider responses and credential details out of MR and DingTalk output. */
function safeExternalErrorMessage(err: unknown): string {
	const message = err instanceof Error ? err.message : "unknown error";
	// T06: bot-controlled marker — safe to surface verbatim.
	if (message.includes("session 文件缺失")) return message;
	if (message.includes("no available model candidate")) {
		return "没有可用的模型候选";
	}
	if (message.includes("PI_CODING_AGENT_DIR")) return "worker 配置目录缺失";
	if (message.includes("CIHEAL_BOT_ROOT")) return "bot 发布配置缺失";
	return "agent 运行失败；详情见服务日志";
}

/**
 * Discover the most recent retained session jsonl under an agent dir (T06).
 * Pi persists sessions under `<agentDir>/sessions/<encoded-cwd>/`; fall back
 * to any *.jsonl under the agent dir. Fail loud when none exists — a resume
 * must never silently start a fresh session.
 */
export function findSessionFile(agentDir: string): string {
	if (!agentDir) {
		throw new Error("session 文件缺失：agent dir 未配置");
	}
	const underSessions = collectJsonl(joinPath(agentDir, "sessions"));
	const candidates = underSessions.length > 0 ? underSessions : collectJsonl(agentDir);
	if (candidates.length === 0) {
		throw new Error(`session 文件缺失：${agentDir} 下无 *.jsonl`);
	}
	candidates.sort((a, b) => statSync(b).mtimeMs - statSync(a).mtimeMs);
	return candidates[0];
}

/** Recursively collect *.jsonl files under a root (missing root → []). */
function collectJsonl(root: string): string[] {
	let entries: import("node:fs").Dirent[];
	try {
		entries = readdirSync(root, { withFileTypes: true });
	} catch {
		return [];
	}
	const found: string[] = [];
	for (const entry of entries) {
		const full = joinPath(root, entry.name);
		if (entry.isDirectory()) found.push(...collectJsonl(full));
		else if (entry.isFile() && entry.name.endsWith(".jsonl")) found.push(full);
	}
	return found;
}
