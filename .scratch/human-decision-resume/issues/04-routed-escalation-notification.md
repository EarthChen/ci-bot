# 04 — Routed escalation 通知（主进程统一发送）

**What to build:** 所有 escalated 通知走 ProjectRouter 到路由群；带决策的转交消息附 diagnosis 摘要 + 决策 id + /heal 命令模板 + 过期时间。人工在正确群看到可操作的转交消息。

**Blocked by:** 03

**Status:** ready-for-agent

- [ ] 新增 escalation-notifier 模块：接收 ProjectRouter + GroupMessageSender + DecisionStore，按 event.projectId 路由发送
- [ ] 可决策 escalated 消息体：diagnosis 摘要 + 决策 id + `/heal D-xxx test|prod|drop` 命令模板 + 过期时间
- [ ] 非可决策 escalated 消息体：原有格式（项目/分支/原因），但走路由而非固定 conversationId
- [ ] scheduler 层在收到 worker outcome 后调用 escalation-notifier（替代 worker 自通知）
- [ ] unit test：mock router + sender，验证路由选择 + 消息体格式
