# 05 — 并发与调度（N>1、按项目串行、跨 pipeline 过期、背压）

**要构建什么：** 把调度器从 N=1 扩到全局并发上限 N + 溢出 FIFO 排队（不丢）、按项目串行队列（一个项目的失败不阻塞另一个）、跨 pipeline 过期（新推送到达时，worker 跑完当前 pipeline 后取队列最新；过期 commit 的 MR 标"rebase 或丢弃" + 钉钉）。多 worker 并行，per-worker 隔离（PI_CODING_AGENT_DIR + --session-dir + cwd）。队列过长发钉钉告警供人工介入。

**Blocked by:** 02（真实 pi agent——需要有能跑的修复才能扩并发）

**Status:** ready-for-agent

- [ ] 全局并发上限 N（可配，值按部署机资源实测 TBD）
- [ ] 溢出 FIFO 排队（不丢）；队列过长 → 钉钉告警
- [ ] 按项目串行队列（跨项目并行，项目内串行）
- [ ] 跨 pipeline 过期：当前 pipeline 跑完再取队列最新；过期 commit MR 标"rebase 或丢弃" + 钉钉（不中断，不浪费已消耗 turn）
- [ ] per-worker 隔离：PI_CODING_AGENT_DIR + --session-dir + cwd（pi 共享状态隔离）
- [ ] 端到端 fixture：同 pipeline 重试 → 一次修复；pipeline B 在 A 跑时到达 → A 跑完再 B，A 的 MR 标过期；并发达上限 N → 事件排队不丢
