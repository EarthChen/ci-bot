import type { PipelineEvent } from "../types.js";
import { REPAIR_BRANCH_PREFIX } from "./worktree.js";

/**
 * 修复分支名：MR 事件按源 MR 分支稳定收敛；非 MR 事件保持 ref-sha8（向后兼容）。
 * 纯函数，不依赖本地状态。
 */
export function repairBranchName(event: PipelineEvent): string {
	if (event.mrSourceBranch) {
		return `${REPAIR_BRANCH_PREFIX}${event.mrSourceBranch}`;
	}
	return `${REPAIR_BRANCH_PREFIX}${event.ref}-${event.sha.slice(0, 8)}`;
}
