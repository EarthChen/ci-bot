# 12 — CONTEXT.md + ADR-0003

**What to build:** 领域词汇入库；架构决策记录在案。可与实现并行。

**Blocked by:** None — can start immediately

**Status:** done (commit 7c67325)

- [ ] CONTEXT.md 新增词汇：Human decision、Awaiting decision、Resume、Decision invalidation、Retained scene（含 _Avoid_ 反模式）
- [ ] docs/adr/0005-escalation-scene-retention.md：记录从 per-event 临时 worker 到部分 worker 长生命周期的架构转变、磁盘 vs 可恢复性权衡、一轮介入限制的 rationale
- [ ] ADR 满足三条件：硬逆转、无上下文会惊讶、真实权衡
