# 05 — /heal 命令解析与执行

**What to build:** 人工在群里 @bot /heal D-xxx test|prod|drop [备注] 被正确解析、校验、执行；决策状态流转；prod/drop 立即清理现场并通知；test 触发恢复 enqueue。无效输入拒绝并回用法。

**Blocked by:** 01, 04

**Status:** ready-for-agent

- [ ] heal-command 模块：解析 `/heal <id> test|prod|drop [remark]`，校验 id 存在且 status=awaiting_decision
- [ ] test 决策：更新 store status=resumed，记录 decided_by/remark，scheduler enqueue resume task（key=projectId）
- [ ] prod 决策：更新 store status=closed，清理现场（cwd/worktree/branch），routed 通知"已确认源码 bug"
- [ ] drop 决策：更新 store status=dropped，清理现场，routed 通知"已丢弃"
- [ ] 拒绝场景：无效 id / 已消费 id / 私聊 → reply 用法提示
- [ ] 审计记录 decider staffId/nick
- [ ] main.ts wire：streamBot onMessage 中注册 handleHealCommand
- [ ] unit test：mock store + scheduler + notifier，覆盖全部分支
