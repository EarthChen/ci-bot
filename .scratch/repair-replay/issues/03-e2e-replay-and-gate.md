# 03 — e2e：同 MR 二次 pipeline 全链路

**What to build:** stub 模式下两条完整链路可端到端验证：(a) pipeline A 修复开 MR → 同 MR pipeline B 失败（源 MR 未合并）→ 重放机制被触发（fake worktree 无上游 → skipped 路径，审计可断言）+ 增量修复 → force-push 原地更新修复 MR；(b) 源 MR 已合并后 pipeline 到达 → 终局跳过闸门生效。applied/empty/conflict 的重放语义由真 git 单测覆盖（worktree.test.ts + run-repair.test.ts），e2e 验证编排不新造 fake 上游。

**Blocked by:** 01（MR 终局跳过闸门）, 02（修复重放核心）

**Status:** done

- [x] 链路 (a)：第二次 pipeline 命中存档，replayChanges 被调用，审计 trace 含 `replay.outcome`，终局 force-push 更新同一修复 MR（不新开）
- [x] 链路 (b)：merged MR 的新 pipeline 不 spawn worker，通知尾注 + 审计可断言
- [x] sidecar（glab-mr-creates / dingtalk-sent / verify-calls）断言与单测口径一致
