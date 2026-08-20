# 06 — Steer 取代通知

**What to build:** 修复运行中用户对同一 MR 推新提交时，正在工作的 agent 立即收到通知（steer），带着 old sha→new sha 与变更清单在自己的上下文里自行更新代码（迁移或重做由 agent 裁决）；未送达窗口的连续推送合并为一条带最新 sha 的通知；新提交已跑绿时附「可收尾」。取代不再依赖 agent 事后才发现。

**Blocked by:** 01（steer 语义 spike）、03（队列合并 + 绿灯短路）、04（存档放宽 + 作废收窄）、05（worker 控制通道）

**Status:** ready-for-agent

- [ ] 运行中同 MR 新 pipeline → 活 session 收到 steer，内容含 old sha→new sha、变更文件清单、处置指令；新 pipeline 已绿时附「可收尾」
- [ ] 合并仅发生在未送达窗口：连推多次只送达一条 steer，带最新 sha
- [ ] 不变式成立：agent 看到的 sha 序列单调收敛到真实最新——可跳过中间态、永不落后、永不静默丢失
- [ ] 审计记录 supersede 链：哪个 pipeline 取代哪个、steer 发送/送达时间
- [ ] e2e：运行中三连推送 → stub session 恰收到 1 条含最终 sha 的 steer
