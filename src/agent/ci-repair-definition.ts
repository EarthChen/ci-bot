/**
 * CI Repair Agent — the first static Vertical Agent definition.
 *
 * Declares the CI-specific prompt, resources, and policies that the shared
 * runtime uses to create a session. Business logic (result parsing, G3, MR)
 * stays in the CI domain (RealAgentRunner), not in the shared runtime.
 *
 * The definition is responsible for writing spill files (CI log, MR diff)
 * to the worker cwd before building the prompt, keeping the prompt thin.
 */

import type { AgentDefinition } from "../agent-runtime/runtime.js";
import type { AgentRunInput } from "./runner.js";
import { join as joinPath } from "node:path";
import { writeFileSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";

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
 * The cwd is captured in the prompt builder so spill files are written
 * to the correct location before the prompt references them.
 */
export function createCiRepairDefinition(
	cwd: string,
): AgentDefinition<AgentRunInput> {
	return {
		id: "ci-repair",
		modelPolicy: "default",
		capabilityProfile: "workspace-coding",
		resources: {
			appendSystemPromptPath: ".pi/APPEND_SYSTEM.md",
			skillPaths: [".agents/skills/ci-self-heal-playbook"],
		},
		buildPrompt: (input) => buildCiPrompt(input, cwd),
	};
}
