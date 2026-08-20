# 02 — glab 查询能力扩展

**What to build:** 为修复 MR 恒一与终局新鲜度闸门提供共用的 glab 查询能力：按 source_branch 查询 bot 修复 MR 的存在与状态、取 MR 源分支最新 HEAD。fake 与 real 双模式一致，fake 侧可被 sidecar 断言。

**Blocked by:** None — can start immediately

**Status:** ready-for-agent

- [ ] 按 source_branch 查询 MR：返回状态（open/merged/closed）与 iid；不存在时返回空而非报错
- [ ] 取 MR 源分支最新 HEAD sha：失败时响亮报错，不静默返回空
- [ ] fake 模式两个查询均可被测试注入与断言（sidecar 或内存桩），real 模式走 glab CLI
- [ ] 单测覆盖两个查询的正常与空结果分支
