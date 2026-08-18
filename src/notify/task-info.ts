/**
 * 任务元信息格式化（钉钉结构化通知共用）。
 *
 * 终局上报（转交/修复成功/异常）与即时播报共用的任务信息渲染：
 * 模型/思考深度、轮数/token/成本/耗时、session 复用、失败分类，
 * 以及原始失败播报的引用块（DingTalk markdown 引用语法）。
 */

import type { AgentRunStats } from "../types.js";

/** 引用块最大行数（原始播报截断，避免钉钉消息过长）。 */
const MAX_QUOTED_LINES = 10;

/** 人类可读耗时：391325ms → "6m31s"。 */
export function formatDuration(ms: number): string {
	const totalSec = Math.max(0, Math.round(ms / 1000));
	const h = Math.floor(totalSec / 3600);
	const m = Math.floor((totalSec % 3600) / 60);
	const s = totalSec % 60;
	if (h > 0) return `${h}h${m}m${s}s`;
	if (m > 0) return `${m}m${s}s`;
	return `${s}s`;
}

/** 任务元信息行（无 stats → 空数组）。 */
export function taskInfoLines(stats?: AgentRunStats): string[] {
	if (!stats) return [];
	return [
		...(stats.model
			? [
					`模型：${stats.model.provider}/${stats.model.model}（思考深度：${stats.model.thinkingLevel}）`,
				]
			: []),
		`轮数：${stats.turns}｜Tokens：${stats.tokens.toLocaleString("en-US")}｜成本：$${stats.cost}｜耗时：${formatDuration(stats.durationMs)}`,
		stats.reusedFromPipeline == null
			? "Session：全新"
			: `Session：复用（源自 pipeline ${stats.reusedFromPipeline}）`,
		...(stats.failureClass == null
			? []
			: [`失败分类：class ${stats.failureClass}`]),
	];
}

/** 任务信息小节（markdown 项目列表；无 stats → 空数组）。 */
export function taskInfoSection(stats?: AgentRunStats): string[] {
	const lines = taskInfoLines(stats);
	if (lines.length === 0) return [];
	return ["**任务信息**", ...lines.map((l) => `- ${l}`)];
}

/** 原始失败播报引用块（markdown 引用；缺省 → 空数组）。 */
export function quoteSection(original?: string): string[] {
	if (!original) return [];
	const lines = original
		.split("\n")
		.filter((l) => l.trim() !== "")
		.slice(0, MAX_QUOTED_LINES);
	if (lines.length === 0) return [];
	return ["**原始失败播报**", ...lines.map((l) => `> ${l}`), ""];
}