import type { AgentSession } from "@earendil-works/pi-coding-agent";
import { logger } from "../util/log.js";
import type { SchedulingPolicy } from "./scheduler.js";

export interface BudgetConfig {
	readonly totalTokenLimit: number;
	readonly perTurnTokenLimit: number;
}

const DEFAULT_BUDGET: BudgetConfig = {
	totalTokenLimit: 200_000,
	perTurnTokenLimit: 50_000,
};

export interface AgentResources {
	readonly appendSystemPromptPath: string;
	readonly skillPaths: readonly string[];
}

export interface AgentDefinition<Input> {
	readonly id: string;
	readonly modelPolicy: string;
	readonly capabilityProfile: string;
	readonly resources: AgentResources;
	/** Per-agent scheduling policy (serial key + requested parallelism degree). */
	readonly schedulingPolicy: SchedulingPolicy;
	buildPrompt(input: Input): string;
}

export interface RuntimeSessionRequest<Input> {
	readonly cwd: string;
	readonly definition: AgentDefinition<Input>;
}

export interface RuntimeSessionBundle {
	readonly session: AgentSession;
	readonly dispose: () => void;
	/** 本次 session 选中的模型（CI runner 填充；结构化声明避免跨层类型依赖）。 */
	readonly modelInfo?: {
		readonly provider: string;
		readonly model: string;
		readonly thinkingLevel: string;
	};
}

/** A started session kept open for follow-up prompts (retry across CI runs). */
export interface RuntimeOpenSession {
	readonly result: RuntimeRunResult;
	readonly session: AgentSession;
	readonly dispose: () => void;
	/** 本次 session 选中的模型（CI runner 填充；透传给调用方做终局上报）。 */
	readonly modelInfo?: {
		readonly provider: string;
		readonly model: string;
		readonly thinkingLevel: string;
	};
}

export type RuntimeSessionFactory = 
	<Input>(request: RuntimeSessionRequest<Input>) => Promise<RuntimeSessionBundle>

export interface RuntimeRunRequest<Input> {
	readonly cwd: string;
	readonly definition: AgentDefinition<Input>;
	readonly input: Input;
}

export interface RuntimeMetrics {
	readonly turns: number;
	readonly tokens: number;
}

export type RuntimeRunResult =
	| {
			readonly status: "completed";
			readonly finalText: string;
			readonly metrics: RuntimeMetrics;
	  }
	| {
			readonly status: "budget_exceeded";
			readonly reason: string;
			readonly metrics: RuntimeMetrics;
	  }
	| {
			readonly status: "failed";
			readonly failure: "session_setup_failed" | "session_execution_failed";
			readonly metrics: RuntimeMetrics;
	  };

interface BudgetMonitor {
	readonly unsubscribe: () => void;
	readonly metrics: () => RuntimeMetrics;
	readonly breachReason: () => string | undefined;
}

/** Runs static Vertical Agent definitions through a caller-provided Pi session. */
export class SharedAgentRuntime {
	private readonly sessionFactory: RuntimeSessionFactory;
	private readonly budget: BudgetConfig;

	constructor(opts: {
		readonly sessionFactory: RuntimeSessionFactory;
		readonly budget?: Partial<BudgetConfig>;
	}) {
		this.sessionFactory = opts.sessionFactory;
		this.budget = { ...DEFAULT_BUDGET, ...opts.budget };
	}

	async run<Input>(
		request: RuntimeRunRequest<Input>,
	): Promise<RuntimeRunResult> {
		let bundle: RuntimeSessionBundle;
		try {
			bundle = await this.sessionFactory({
				cwd: request.cwd,
				definition: request.definition,
			});
		} catch (err) {
			logger.error({ err }, "shared agent session setup failed");
			return {
				status: "failed",
				failure: "session_setup_failed",
				metrics: { turns: 0, tokens: 0 },
			};
		}

		const monitor = subscribeBudget(bundle.session, this.budget);
		try {
			await bundle.session.prompt(
				request.definition.buildPrompt(request.input),
			);
			const breachReason = monitor.breachReason();
			if (breachReason) {
				return {
				status: "budget_exceeded",
				reason: breachReason,
				metrics: monitor.metrics(),
			};
			}
			return {
				status: "completed",
				finalText: extractLastAssistantText(bundle.session),
				metrics: monitor.metrics(),
			};
		} catch (err) {
			logger.error({ err }, "shared agent session execution failed");
			const breachReason = monitor.breachReason();
			if (breachReason) {
				return {
				status: "budget_exceeded",
				reason: breachReason,
				metrics: monitor.metrics(),
			};
			}
			return {
				status: "failed",
				failure: "session_execution_failed",
				metrics: monitor.metrics(),
			};
		} finally {
			monitor.unsubscribe();
			bundle.dispose();
		}
	}

	/**
	 * Start a session but keep it open (no dispose) so the caller can re-prompt
	 * it via {@link continueSession} after an external CI re-check (retry loop).
	 */
	async runSession<Input>(
		request: RuntimeRunRequest<Input>,
	): Promise<RuntimeOpenSession> {
		let bundle: RuntimeSessionBundle;
		try {
			bundle = await this.sessionFactory({
				cwd: request.cwd,
				definition: request.definition,
			});
		} catch (err) {
			logger.error({ err }, "shared agent session setup failed");
			return {
				result: {
				status: "failed",
				failure: "session_setup_failed",
				metrics: { turns: 0, tokens: 0 },
				},
			session: undefined as unknown as AgentSession,
				dispose: () => {},
			};
		}
		const monitor = subscribeBudget(bundle.session, this.budget);
		try {
			await bundle.session.prompt(
				request.definition.buildPrompt(request.input),
			);
			const breachReason = monitor.breachReason();
			const result: RuntimeRunResult = breachReason
				? {
					status: "budget_exceeded",
					reason: breachReason,
					metrics: monitor.metrics(),
				}
				: {
					status: "completed",
					finalText: extractLastAssistantText(bundle.session),
					metrics: monitor.metrics(),
				};
			return {
				result,
				session: bundle.session,
				dispose: bundle.dispose,
				...(bundle.modelInfo ? { modelInfo: bundle.modelInfo } : {}),
			};
		} catch (err) {
			logger.error({ err }, "shared agent session execution failed");
			const breachReason = monitor.breachReason();
			const result: RuntimeRunResult = breachReason
				? {
					status: "budget_exceeded",
				reason: breachReason,
				metrics: monitor.metrics(),
				}
				: {
					status: "failed",
					failure: "session_execution_failed",
					metrics: monitor.metrics(),
				};
			return {
				result,
				session: bundle.session,
				dispose: bundle.dispose,
				...(bundle.modelInfo ? { modelInfo: bundle.modelInfo } : {}),
			};
		} finally {
			monitor.unsubscribe();
		}
	}

	/**
	 * Re-prompt an already-open session (same conversation, cumulative budget).
	 * Used when an MR's CI still fails and the bot wants the agent to continue
	 * fixing within the same worktree + session.
	 */
	async continueSession(
		session: AgentSession,
		prompt: string,
	): Promise<RuntimeRunResult> {
		const monitor = subscribeBudget(session, this.budget);
		try {
			await session.prompt(prompt);
			const breachReason = monitor.breachReason();
			if (breachReason) {
				return {
				status: "budget_exceeded",
				reason: breachReason,
				metrics: monitor.metrics(),
			};
			}
			return {
				status: "completed",
				finalText: extractLastAssistantText(session),
				metrics: monitor.metrics(),
			};
		} catch (err) {
			logger.error({ err }, "shared agent session continue failed");
			const breachReason = monitor.breachReason();
			if (breachReason) {
				return {
				status: "budget_exceeded",
				reason: breachReason,
				metrics: monitor.metrics(),
			};
			}
			return {
				status: "failed",
				failure: "session_execution_failed",
				metrics: monitor.metrics(),
			};
		} finally {
			monitor.unsubscribe();
		}
	}
}

function subscribeBudget(
	session: AgentSession,
	budget: BudgetConfig,
): BudgetMonitor {
	let turns = 0;
	let tokens = 0;
	let reason: string | undefined;
	const unsubscribe = session.subscribe((event) => {
		if (event.type !== "turn_end") return;
		turns++;
		const turnTokens = readTurnTokens(event.message);
		if (turnTokens === undefined) return;
		tokens += turnTokens;
		if (turnTokens > budget.perTurnTokenLimit) {
			reason = `single turn token ${turnTokens} exceeded ${budget.perTurnTokenLimit}`;
			abortForBudget(session);
			return;
		}
		if (tokens > budget.totalTokenLimit) {
			reason = `total token ${tokens} exceeded ${budget.totalTokenLimit}`;
			abortForBudget(session);
		}
	});
	return {
		unsubscribe,
		metrics: () => ({ turns, tokens }),
		breachReason: () => reason,
	};
}

function readTurnTokens(message: unknown): number | undefined {
	if (!message || typeof message !== "object") return undefined;
	const usage = (message as { usage?: unknown }).usage;
	if (!usage || typeof usage !== "object") return undefined;
	const totalTokens = (usage as { totalTokens?: unknown }).totalTokens;
	return typeof totalTokens === "number" ? totalTokens : undefined;
}

function abortForBudget(session: AgentSession): void {
	void session.abort().catch((err) => {
		logger.warn({ err }, "shared agent budget abort failed");
	});
}

function extractLastAssistantText(session: AgentSession): string {
	for (let index = session.messages.length - 1; index >= 0; index--) {
		const message = session.messages[index];
		if (message?.role !== "assistant") continue;
		const text = extractText(message);
		if (text) return text;
	}
	return "";
}

function extractText(message: { readonly content?: unknown }): string {
	if (typeof message.content === "string") return message.content;
	if (!Array.isArray(message.content)) return "";
	return message.content
		.map((block: { readonly type?: string; readonly text?: string }) =>
			block.type === "text" && typeof block.text === "string" ? block.text : "",
		)
		.join("");
}
