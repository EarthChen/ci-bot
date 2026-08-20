# 09 — 领域词汇与文档同步

**What to build:** 新机制落地后的文档对齐：领域词汇表反映决策作废的新范围并收录 supersede 概念；AGENTS.md 规则区与 playbook 相关表述同步新边界，让后续 agent 与人读到的规则与代码行为一致。

**Blocked by:** 08（修复 MR 恒一）

**Status:** ready-for-agent

- [ ] CONTEXT.md：Decision invalidation 词条从「same project」修订为「same MR」；新增 Supersede 词条
- [ ] AGENTS.md：Rules 区同步 steer 取代、MR 恒一、终局闸门、绿灯短路、作废收窄的边界表述
- [ ] ADR-0011 落 docs/adr/：记录 supersede + session 延续决策树与否决方案（长驻 worker、一 worker 多 session 等）
- [ ] real-run-playbook 涉及 session 复用与修复 MR 的段落与新行为一致
