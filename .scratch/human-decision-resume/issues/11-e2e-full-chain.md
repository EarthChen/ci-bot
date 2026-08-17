# 11 — e2e 完整链路验证

**What to build:** 真实子进程 + fake deps 端到端验证全路径：escalated → 转交通知 → /heal test → resume → MR；以及 prod/drop/TTL/invalidation/二次转交终局。

**Blocked by:** 06, 07, 08, 09

**Status:** done (commit 6b8183e)

- [ ] e2e：agent escalated → 路由群收到带 id 的转交消息 → /heal test 备注 → 新 worker 用原 session 继续 → MR 创建成功
- [ ] e2e：/heal prod → 现场清理 + audit outcome=human_confirmed_prod + 群通知
- [ ] e2e：/heal drop → 现场清理 + audit outcome=dropped
- [ ] e2e：TTL 到期 → 自动清理 + 群通知"已超时关闭"
- [ ] e2e：等待期间同项目新 pipeline → 旧决策 invalidated + 清理 + 群通知
- [ ] e2e：恢复后 agent 再次 escalated → 终局通知，无新决策
- [ ] e2e：无效 id / 已消费 id / 非群聊 → 拒绝并回用法
- [ ] sidecar JSON 验证通知内容和状态流转
