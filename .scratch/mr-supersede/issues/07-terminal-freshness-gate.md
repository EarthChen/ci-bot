# 07 — 终局新鲜度闸门

**What to build:** createMR 前的确定性安全网：校验 agent 的工作基线对照 MR 源分支最新 HEAD，若已被用户新提交取代则丢弃成果、不开 MR、发通知并记审计。与 agent 自律两层独立——即使 steer 没来得及处理，过期修复也出不了闸门。转交类终局不受闸门影响。

**Blocked by:** 02（glab 查询能力扩展）

**Status:** ready-for-agent

- [ ] createMR 前校验工作基线 vs MR 源分支最新 HEAD；被取代则丢弃成果、不开 MR、群通知 + 审计
- [ ] 转交类终局（escalated）不经过闸门、行为不变
- [ ] 基线最新时正常开 MR 路径无变化（现有 run-repair 测试全绿）
- [ ] 测试：fake glab 返回更新 HEAD → 断言无 MR 创建且有通知；返回一致 HEAD → MR 照常创建
