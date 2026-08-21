# 04 — ADR-0012 + 文档同步

**What to build:** `docs/adr/0012-repair-replay-and-mr-terminal-gate.md` 两节：修复重放机制（记录取舍——range-diff+apply-3 而非 cherry-pick / worktree 目录永不复用 / 人工 commit 照带 / conflict 原子降级 / G3 越界整体转交 / force-push 语义维持 / refspec 单次 fetch 不放行全局）；MR 终局跳过闸门（fail-open 理由）。AGENTS.md 架构 Rules 补「修复重放」「终局跳过」两条。核对 CONTEXT.md 的 Repair replay 词条与实现一致。

**Blocked by:** 02（修复重放核心）；01 一并收尾核对

**Status:** done

- [x] ADR-0012 落 docs/adr/，含全部 grilling 取舍记录（Q3/Q4/Q5/Q9/Q10/Q12）
- [x] AGENTS.md Rules 段落更新，与实现零冲突
- [x] CONTEXT.md Repair replay 词条与最终实现核对一致
