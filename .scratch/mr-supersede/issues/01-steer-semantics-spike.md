# 01 — Steer 语义 spike

**What to build:** 对 pi SDK 的 steer 机制取得定论事实，让 06 的实现不再基于假设：steer 注入对长时工具调用（如正在跑的 mvn/bash）的精确时点、`queue_update` 事件能否作为 steer 送达的可靠信号、以及未送达 steer 的内容替换/合并姿势。若结论是「turn 边界注入」而非立即打断，记录实现退化路径（不变式不受影响）。

**Blocked by:** None — can start immediately

**Status:** done

- [x] steer 打断长时工具调用的时点有定论（立即打断 / 当前工具完成后 / turn 边界），附可复现的验证证据
- [x] `queue_update` 事件作为 steer 送达信号的可靠性有定论，覆盖 session 在送达前终止的边界
- [x] 未送达 steer 的内容替换/合并姿势有定论（SDK 原生支持与否、bot 侧需要维护什么状态）
- [x] spike 结论落 feature 目录报告，并据此更新 spec 中对 06 的实现预期

**Report:** `.scratch/mr-supersede/spike-01-steer-findings.md`  
**Tests:** `tests/spike/steer-semantics.test.ts`
