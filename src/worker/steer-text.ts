import type { SupersedePayload } from "./control-types.js";

/** Assemble supersede notification text for AgentSession.steer() (ticket 06). */
export function buildSupersedeSteerText(payload: SupersedePayload): string {
	const files =
		payload.changedFiles && payload.changedFiles.length > 0
			? payload.changedFiles.join(", ")
			: "（未提供）";
	const lines = [
		"## MR 源分支已更新",
		`- 旧 sha: ${payload.oldSha} → 新 sha: ${payload.newSha}`,
		`- 变更文件: ${files}`,
		"- 处置: fetch origin → 比对当前工作与更新 → 决定保留还是放弃当前改动",
	];
	if (payload.greenStatus) {
		lines.push("⚠️ 新 pipeline 已绿，可收尾");
	}
	return lines.join("\n");
}
