# 05 — Worker 控制通道打通

**What to build:** 打通主进程→运行中 worker 的控制消息通道（现有 IPC 管道的反向），让 06 的 steer 信号有路可走。本票只交付管道本身：主进程能发、worker 能收并留下可观测痕迹，消息契约可扩展。

**Blocked by:** None — can start immediately

**Status:** ready-for-agent

- [ ] 主进程可向运行中 worker 发送控制消息；worker 侧监听并留下可观测痕迹（worker 审计日志）
- [ ] 消息契约为可扩展的类型化结构（为 06 的 supersede 消息预留），不引入第二条 IPC 通道
- [ ] 向已结束的 worker 发消息幂等：静默丢弃 + 记日志，不报错不崩溃
- [ ] e2e：worker 运行中发控制消息，可观测到 worker 侧 ack
