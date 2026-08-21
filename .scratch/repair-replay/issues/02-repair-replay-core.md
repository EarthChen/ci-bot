# 02 — 修复重放核心（四路径）

**What to build:** 同 MR 未合并的新 pipeline，worktree 照常新建后，把上轮已 push 的修复改动 git 层重放进新 worktree：单次 `git fetch origin <repairBranch>`（FETCH_HEAD，不动全局 refspec 负向排除）+ `git diff <存档meta.sha>..FETCH_HEAD | git apply -3`。agent 只处理增量违规，不再重做历史修复。人工 push 到修复分支的 commit 照带（G3 白名单兜底）。

**Blocked by:** None — can start immediately

**Status:** done

- [x] applied：新 worktree 工作区含上轮修复，agent prompt 注入「已重放，先验证再只修增量」（continue prompt 变体）
- [x] empty（新代码已含修复，diff 为空）：no-op 不报错，prompt 注入「上轮修复已包含在新代码中，勿重做」
- [x] conflict（apply 非零退出）：原子清理工作区，退回全新修复（session 复用照旧），prompt 不注入，审计记 conflict
- [x] skipped（无上游修复分支 / 无存档）：行为与现状完全一致
- [x] 审计 trace 增 `replay: { fromPipeline, commitRange, outcome }`，metrics.jsonl 增 outcome 计数
- [x] 含人工 commit 的上游分支照带重放（单测覆盖）
- [x] 重放改动越出新 MR diff hunk ±5 时整体走现有 G3 转交/决策路径，不引入部分重放语义
