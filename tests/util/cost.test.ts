import { describe, expect, it } from "vitest";
import {
	addTokenUsage,
	emptyTokenUsage,
	estimateUsageCost,
	usageTotalTokens,
	type TokenUsageComponents,
} from "../../src/util/cost.js";

/** 构造分量 usage 的便捷工厂（缺省 0）。 */
function usage(partial: Partial<TokenUsageComponents>): TokenUsageComponents {
	return { ...emptyTokenUsage(), ...partial };
}

describe("estimateUsageCost — 分量计价（cache/fresh 分价）", () => {
	it("空 usage 成本为 0", () => {
		expect(estimateUsageCost(emptyTokenUsage())).toBe(0);
	});

	it("fresh input 按基础单价（默认 0.001/1k）", () => {
		expect(estimateUsageCost(usage({ input: 1000 }))).toBe(0.001);
		expect(estimateUsageCost(usage({ input: 50000 }))).toBe(0.05);
	});

	it("output/reasoning 按 4× input 计价", () => {
		expect(estimateUsageCost(usage({ output: 1000 }))).toBe(0.004);
		expect(estimateUsageCost(usage({ reasoning: 1000 }))).toBe(0.004);
	});

	it("cacheRead 按 0.1× input 计价——累计 cache 重读不再虚高 10 倍", () => {
		// 实测场景：11.3M cacheRead 旧公式计 $11.3，分量计价约 $1.13
		expect(estimateUsageCost(usage({ cacheRead: 10000 }))).toBe(0.001);
	});

	it("cacheWrite 按 1× input 计价", () => {
		expect(estimateUsageCost(usage({ cacheWrite: 1000 }))).toBe(0.001);
	});

	it("混合分量叠加", () => {
		// 1k input(0.001) + 1k output(0.004) + 10k cacheRead(0.001) = 0.006
		expect(
			estimateUsageCost(usage({ input: 1000, output: 1000, cacheRead: 10000 })),
		).toBe(0.006);
	});

	it("BOT_TOKEN_UNIT_COST_PER_1K 覆盖基础单价（各分量同比缩放）", () => {
		const orig = process.env.BOT_TOKEN_UNIT_COST_PER_1K;
		process.env.BOT_TOKEN_UNIT_COST_PER_1K = "0.002";
		try {
			expect(estimateUsageCost(usage({ input: 1000 }))).toBe(0.002);
			expect(estimateUsageCost(usage({ cacheRead: 1000 }))).toBe(0.0002);
		} finally {
			if (orig === undefined) delete process.env.BOT_TOKEN_UNIT_COST_PER_1K;
			else process.env.BOT_TOKEN_UNIT_COST_PER_1K = orig;
		}
	});
});

describe("usage 累加辅助", () => {
	it("addTokenUsage 逐分量相加", () => {
		const sum = addTokenUsage(
			usage({ input: 100, cacheRead: 200 }),
			usage({ input: 5, output: 7, cacheRead: 8 }),
		);
		expect(sum).toEqual({
			input: 105,
			output: 7,
			cacheRead: 208,
			cacheWrite: 0,
			reasoning: 0,
		});
	});

	it("usageTotalTokens 为全分量之和", () => {
		expect(
			usageTotalTokens(usage({ input: 1, output: 2, cacheRead: 3, cacheWrite: 4, reasoning: 5 })),
		).toBe(15);
	});
});
