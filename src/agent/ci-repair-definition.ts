/**
 * CI Repair Agent — the first static Vertical Agent definition.
 *
 * Declares the CI-specific prompt, resources, and policies that the shared
 * runtime uses to create a session. Business logic (result parsing, G3, MR)
 * stays in the CI domain (RealAgentRunner), not in the shared runtime.
 *
 * All agent-facing resources (APPEND_SYSTEM.md, ci-self-heal-playbook skill)
 * live under src/agents/ci-repair/resources/ — not in bot-level shared paths.
 */

import type { AgentDefinition } from "../agent-runtime/runtime.js";
import type { SchedulingPolicy } from "../agent-runtime/scheduler.js";
import type { AgentRunInput } from "./runner.js";
import { join as joinPath } from "node:path";
import { writeFileSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";

/**
 * Resolve the CI Repair agent's resource directory (bundled with the bot release).
 * Called lazily — only when the definition's resources are actually consumed.
 */
function resolveCiRepairResources(): string {
	const botRoot = process.env.CIHEAL_BOT_ROOT;
	if (!botRoot)
		throw new Error("CIHEAL_BOT_ROOT is required for CI Repair resources");
	return joinPath(botRoot, "src", "agents", "ci-repair", "resources");
}

function buildCiPrompt(input: AgentRunInput, cwd: string): string {
	const ciLogPath = joinPath(cwd, "ci-log.txt");
	const mrDiffPath = joinPath(cwd, "mr-diff.patch");
	writeText(ciLogPath, input.ciLog);
	if (input.mrDiff) writeText(mrDiffPath, input.mrDiff);

	return [
		`/skill:ci-self-heal-playbook`,
		``,
		`# 任务`,
		`分支 ${input.ref} @ ${input.sha.slice(0, 8)} 的 pipeline 单测失败。`,
		``,
		`# 输入文件（用 read 工具读取，不要靠 prompt 里的内容）`,
		`- CI 日志：${ciLogPath}`,
		input.mrDiff ? `- MR diff：${mrDiffPath}` : `- MR diff：无`,
		``,
		`# MR 提交（你自己完成，勿依赖 bot）`,
		`- 源分支（push 到此）：${input.sourceBranch}`,
		`- 目标分支（MR target）：${input.targetBranch}`,
		`- 步骤：改文件 → git add → git commit → git push origin ${input.sourceBranch} → glab mr create（源/目标分支如上）→ 结构化输出 fixed.mrUrl 填 MR URL`,
	].join("\n");
}

function writeText(abs: string, content: string): void {
	mkdirSync(dirname(abs), { recursive: true });
	writeFileSync(abs, content, "utf8");
}

/**
 * Build the prompt the bot injects when an MR's CI still fails and the agent
 * must continue within the SAME session + worktree, updating (not recreating)
 * the existing MR. The new CI log is written to a file; the prompt only gives
 * its path (never the log text) so large logs stay out of the LLM context.
 */
export function buildContinuePrompt(
	input: AgentRunInput,
	priorMrUrl: string,
	newCiLog: string,
): string {
	const ciLogPath = joinPath(input.cwd, "ci-log-retry.txt");
	writeText(ciLogPath, newCiLog);
	return [
		`# CI 仍失败，继续修复（复用本次 session，勿新建 MR）`,
		``,
		`你之前开的 MR（必须更新同一 MR，不要新建）：`,
		`- MR URL：${priorMrUrl}`,
		`- 源分支（继续 push 到此更新 MR）：${input.sourceBranch}`,
		`- 目标分支：${input.targetBranch}`,
		``,
		`# 新的 CI 失败日志`,
		`用 read 工具读取：${ciLogPath}`,
		``,
		`# 任务`,
		`1. 读新 CI 日志，定位仍失败的根因。遵守范围闸：test 失败只改测试/文档；static-analysis/Checkstyle 可改 diff 内 src/main；超出 diff 转交。`,
		`2. 修复后 git add → git commit → git push origin ${input.sourceBranch}（更新同一 MR，勿新建 MR）。`,
		`3. 末条消息输出结构化 JSON：fixed 填同一 mrUrl，或 escalated 说明转交原因。`,
	].join("\n");
}

/** CI Repair scheduling policy: serialize per projectId, request up to 4 parallel repos. */
export const CI_REPAIR_SCHEDULING_POLICY: SchedulingPolicy = {
	serialKey: (event) => event.projectId,
	maxParallel: 4,
};

/**
 * Create a CI repair definition bound to a specific worker cwd.
 * Resource paths are resolved lazily when accessed (not at creation time),
 * so that tests injecting their own sessionFactory don't need CIHEAL_BOT_ROOT.
 */
export function createCiRepairDefinition(
	cwd: string,
): AgentDefinition<AgentRunInput> {
	return {
		id: "ci-repair",
		modelPolicy: "default",
		capabilityProfile: "workspace-coding",
		schedulingPolicy: CI_REPAIR_SCHEDULING_POLICY,
		get resources() {
			const resources = resolveCiRepairResources();
			return {
				appendSystemPromptPath: joinPath(resources, "APPEND_SYSTEM.md"),
				skillPaths: [joinPath(resources, "skills", "ci-self-heal-playbook")],
			};
		},
		buildPrompt: (input) => buildCiPrompt(input, cwd),
	};
}
