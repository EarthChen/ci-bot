/**
 * Token 成本估算——repair-outcome（终局审计）与 agent-runtime（turn_end
 * IPC 实时上报）共用同一公式，避免两处漂移。
 */

/** 估算成本 = tokens × 单价（BOT_TOKEN_UNIT_COST_PER_1K，默认 0.001/1k）。 */
export function estimateTokenCost(tokens: number): number {
	const per1k = Number(process.env.BOT_TOKEN_UNIT_COST_PER_1K ?? "0.001");
	return Math.round((tokens / 1000) * per1k * 1_000_000) / 1_000_000;
}
