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

/** Write spill files to cwd and return the task prompt. */
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
	].join("\n");
}

function writeText(abs: string, content: string): void {
	mkdirSync(dirname(abs), { recursive: true });
	writeFileSync(abs, content, "utf8");
}

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
