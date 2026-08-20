/**
 * Token 成本估算——repair-outcome（终局审计）与 agent-runtime（turn_end
 * IPC 实时上报）共用同一公式，避免两处漂移。
 *
 * 分量计价（2026-08 修订）：agent loop 的累计 totalTokens 由 KV cache 重读
 * 主导（实测 97%），统一按 fresh 平价计价会虚高约 10 倍。基础单价
 * BOT_TOKEN_UNIT_COST_PER_1K（默认 0.001/1k，即 fresh input 价），其余分量
 * 按行业典型比例折算：output/reasoning = 4× input，cacheRead = 0.1× input，
 * cacheWrite = 1× input。
 */

/** 每 turn usage 的分量（pi session usage 形状，不含 totalTokens/cost）。 */
export interface TokenUsageComponents {
	readonly input: number;
	readonly output: number;
	readonly cacheRead: number;
	readonly cacheWrite: number;
	readonly reasoning: number;
}

/** 生成类 token（output/reasoning）典型单价 ≈ 4× input。 */
const OUTPUT_RATIO = 4;
/** KV cache 命中重读典型单价 ≈ 0.1× input。 */
const CACHE_READ_RATIO = 0.1;

export function emptyTokenUsage(): TokenUsageComponents {
	return { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, reasoning: 0 };
}

export function addTokenUsage(
	a: TokenUsageComponents,
	b: TokenUsageComponents,
): TokenUsageComponents {
	return {
		input: a.input + b.input,
		output: a.output + b.output,
		cacheRead: a.cacheRead + b.cacheRead,
		cacheWrite: a.cacheWrite + b.cacheWrite,
		reasoning: a.reasoning + b.reasoning,
	};
}

/** 全分量之和（≈ usage.totalTokens）。 */
export function usageTotalTokens(usage: TokenUsageComponents): number {
	return usage.input + usage.output + usage.cacheRead + usage.cacheWrite + usage.reasoning;
}

/** 估算成本 = 分量计价（比例见模块注释）。 */
export function estimateUsageCost(usage: TokenUsageComponents): number {
	const per1k = Number(process.env.BOT_TOKEN_UNIT_COST_PER_1K ?? "0.001");
	const inputEquivalent =
		usage.input +
		usage.cacheWrite +
		(usage.output + usage.reasoning) * OUTPUT_RATIO +
		usage.cacheRead * CACHE_READ_RATIO;
	return Math.round((inputEquivalent / 1000) * per1k * 1_000_000) / 1_000_000;
}
