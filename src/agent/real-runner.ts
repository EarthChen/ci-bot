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

import type { AgentResult, Diagnosis, FailureClass } from "../types.js";
import type { AgentRunner, AgentRunInput } from "./runner.js";
import type { DingTalkNotifier } from "../notify/dingtalk.js";
import { logger } from "../util/log.js";
import { join as joinPath } from "node:path";
import { existsSync } from "node:fs";
import type { AgentSession } from "@earendil-works/pi-coding-agent";
import type { BudgetConfig, RuntimeSessionBundle } from "../agent-runtime/runtime.js";
import { SharedAgentRuntime } from "../agent-runtime/runtime.js";
import { createCiRepairDefinition } from "./ci-repair-definition.js";

// Re-export for backward compatibility
export type { BudgetConfig };

/** Factory for creating a session bundle (DI seam for tests). */
export type SessionFactory = (input: AgentRunInput) => Promise<RuntimeSessionBundle>;

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
		const result = await runtime.run({ definition, input, cwd: input.cwd });

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

		// Fire budget DingTalk alert after the session is torn down (best-effort).
		if (result.status === "budget_exceeded" && this.dingtalk) {
			void this.dingtalk
				.send({
					title: "CI 自愈预算告警",
					text: `项目 ${input.projectId} pipeline ${input.pipelineId} 预算超限：${result.reason}`,
				})
				.catch((err) => logger.warn({ err }, "budget alert failed"));
		}

		return { ...agentResult, metrics: result.metrics };
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
		const message = safeExternalErrorMessage(err);
		return {
			kind: "escalated",
			diagnosis: { failureClass: 4, summary: `agent session 异常：${message}` },
			reason: `agent error: ${message}`,
		};
	}
}

/** The default session factory: real `createAgentSession`. */
async function defaultSessionFactory(
	input: AgentRunInput,
): Promise<RuntimeSessionBundle> {
	const session = await createDefaultSession(input);
	return {
		session,
		dispose: () => session.dispose(),
	};
}

async function createDefaultSession(
	input: AgentRunInput,
): Promise<AgentSession> {
	const {
		createAgentSession,
		DefaultResourceLoader,
		SessionManager,
		SettingsManager,
		ModelRuntime,
	} = await import("@earendil-works/pi-coding-agent");
	const {
		loadModelCandidates,
		loadModelProfiles,
		selectModelCandidate,
	} = await import("./model-selection.js");

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
		process.env,
	);
	const profile = loadModelProfiles(joinPath(configDir, "model-profiles.json"))[
		selected.candidate.profile
	];
	if (!profile) {
		throw new Error(
			`model candidate profile not found: ${selected.candidate.profile}`,
		);
	}

	// The worker owns Pi resources. Do not discover settings, extensions, skills,
	// prompts, themes, or context files from the target repository worktree.
	const settingsManager = SettingsManager.create(botRoot, agentDir);
	settingsManager.applyOverrides(profile);
	const resourceLoader = new DefaultResourceLoader({
		cwd: input.cwd,
		agentDir,
		settingsManager,
		noExtensions: true,
		noSkills: true,
		noPromptTemplates: true,
		noThemes: true,
		noContextFiles: true,
		additionalSkillPaths: [resolveBotSkillPath(botRoot)],
		// Keep Pi's built-in tool guidance; target worktree SYSTEM.md is not trusted.
		systemPromptOverride: () => undefined,
		appendSystemPrompt: [joinPath(botRoot, ".pi", "APPEND_SYSTEM.md")],
	});
	await resourceLoader.reload();

	const { session } = await createAgentSession({
		cwd: input.cwd,
		agentDir,
		model: selected.model,
		thinkingLevel: profile.defaultThinkingLevel,
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

function resolveBotSkillPath(botRoot: string): string {
	const skillPath = joinPath(
		botRoot,
		".agents",
		"skills",
		"ci-self-heal-playbook",
	);
	if (!existsSync(skillPath)) {
		throw new Error("CIHEAL_BOT_ROOT does not contain ci-self-heal-playbook");
	}
	return skillPath;
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
	const diagnosis = normalizeDiagnosis(obj.diagnosis);
	if (obj.kind === "fixed" && diagnosis && typeof obj.summary === "string") {
		return { kind: "fixed", diagnosis, summary: obj.summary };
	}
	if (obj.kind === "escalated" && diagnosis && typeof obj.reason === "string") {
		return { kind: "escalated", diagnosis, reason: obj.reason };
	}
	return null;
}

function normalizeDiagnosis(value: unknown): Diagnosis | null {
	if (!value || typeof value !== "object") return null;
	const candidate = value as { failureClass?: unknown; summary?: unknown };
	if (!isFailureClass(candidate.failureClass)) return null;
	if (typeof candidate.summary !== "string") return null;
	return { failureClass: candidate.failureClass, summary: candidate.summary };
}

function isFailureClass(value: unknown): value is FailureClass {
	return (
		value === 1 || value === 2 || value === 3 || value === 4 || value === 5
	);
}
