# 08 — 修复 MR 恒一

**What to build:** 一个源 MR 至多一个 bot 修复 MR：修复分支名按源 MR 收敛（不再钉死 sha），修复时以 GitLab 为事实源决定「原地更新」还是「新开」——人工合并或关闭后自动重开新 MR，关闭后重开注明拒绝语境。review 列表不再堆积过期的 bot MR。

**Blocked by:** 02（glab 查询能力扩展）、07（终局新鲜度闸门）

**Status:** ready-for-agent

- [ ] 修复分支名按源 MR 稳定收敛；同一源 MR 至多存在一个 open 的 bot 修复 MR
- [ ] 修复时按 source_branch 查询 GitLab：open → 原地 push 更新；merged/closed/不存在 → 新开 MR；不建本地状态机
- [ ] close 后重开：MR 描述与群通知注明「上一个修复 MR !N 被关闭，本次为新尝试」
- [ ] bot 自身回流 pipeline 忽略语义无回归（不触发自修循环）
- [ ] e2e：同源 MR 两轮修复 → sidecar 断言 1 次创建、第二轮为 push 更新；close 后下一轮新开且带注明
