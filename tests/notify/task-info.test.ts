import { describe, expect, it } from "vitest";
import {
	formatDuration,
	quoteSection,
	taskInfoLines,
	taskInfoSection,
} from "../../src/notify/task-info.js";

describe("formatDuration — 人类可读耗时", () => {
	it("秒/分/时三档（真实 e2e：391325ms → 6m31s）", () => {
		expect(formatDuration(500)).toBe("1s");
		expect(formatDuration(391325)).toBe("6m31s");
		expect(formatDuration(3_661_000)).toBe("1h1m1s");
	});

	it("负数归零", () => {
		expect(formatDuration(-100)).toBe("0s");
	});
});

describe("taskInfoLines — 任务元信息行", () => {
	const stats = {
		model: { provider: "p", model: "m", thinkingLevel: "medium" },
		turns: 2,
		tokens: 1234,
		cost: 0.0012,
		durationMs: 61000,
	};

	it("无 stats → 空数组（agent 未运行的早筛路径不上报）", () => {
		expect(taskInfoLines(undefined)).toEqual([]);
	});

	it("全新 session：模型/轮数/token/session 全新", () => {
		const lines = taskInfoLines(stats);
		expect(lines[0]).toBe("模型：p/m（思考深度：medium）");
		expect(lines[1]).toBe("轮数：2｜Tokens：1,234｜成本：$0.0012｜耗时：1m1s");
		expect(lines[2]).toBe("Session：全新");
	});

	it("复用 session 与失败分类", () => {
		const lines = taskInfoLines({
			...stats,
			reusedFromPipeline: 99,
			failureClass: 5,
		});
		expect(lines[2]).toBe("Session：复用（源自 pipeline 99）");
		expect(lines[3]).toBe("失败分类：class 5");
	});

	it("无模型（stub runner）→ 省略模型行", () => {
		const { model: _model, ...rest } = stats;
		const lines = taskInfoLines(rest);
		expect(lines[0]).toContain("轮数：");
	});
});

describe("taskInfoSection / quoteSection — markdown 小节渲染", () => {
	it("taskInfoSection 无 stats → []", () => {
		expect(taskInfoSection(undefined)).toEqual([]);
	});

	it("taskInfoSection 有 stats → 标题 + 项目列表", () => {
		const section = taskInfoSection({
			turns: 1,
			tokens: 10,
			cost: 0,
			durationMs: 1000,
		});
		expect(section[0]).toBe("**任务信息**");
		expect(section[1]).toMatch(/^- 轮数：/);
	});

	it("quoteSection 渲染为 markdown 引用并过滤空行", () => {
		const q = quoteSection("line1\n\nline2");
		expect(q[0]).toBe("**原始失败播报**");
		expect(q).toContain("> line1");
		expect(q).toContain("> line2");
		expect(q).not.toContain("> ");
	});

	it("quoteSection 超长截断（避免钉钉消息过长）", () => {
		const lines = Array.from({ length: 20 }, (_, i) => `line${i}`);
		const q = quoteSection(lines.join("\n"));
		expect(q.filter((l) => l.startsWith("> "))).toHaveLength(10);
	});

	it("quoteSection 缺省/空 → []", () => {
		expect(quoteSection(undefined)).toEqual([]);
		expect(quoteSection("")).toEqual([]);
	});
});
