# ADR-0002: agent session 输出持久化

## 状态

已决议（grilling 确认）

## 背景

真实运行 100031437 出现 `empty patch after agent reported fixed`：agent 报 `fixed` 但 `git diff --cached` 为空（bot 自做 `git add -A`，故等价于 agent 最终没留改动）。诊断时无法查看 agent 内部过程——bot 仅捕获 worker stdout 最后 20 行（`stdoutTail`），且被 worker 阶段日志覆盖；worker cwd 在 `finally` 被 `rm`，无 sidecar 留存。

## 决策

在 `real-runner.ts` 的 `createDefaultSession` 创建 session 后，用 `session.subscribe` 把每 turn 的 assistant 文本 + tool 调用 append 到 `CIHEAL_WORKER_LOG_DIR/agent-session.log`。

- 落点选 `$CIHEAL_WORKER_LOG_DIR`（审计目录，**不在 worktree cwd**），因此不被 cleanup 的 `rm(cwd)` 删除，天然持久。
- best-effort：订阅/写文件失败不阻塞 agent 主流程。

## 理由（权衡）

- 诊断价值高：空 patch / escalate 时必须能复盘 agent 是否改文件、跑了什么命令、为何 revert。
- 复用语理：worker.log 已写到同一 `CIHEAL_WORKER_LOG_DIR`，机制一致，无新基础设施。
- 风险低：`session.subscribe` 与现有 `subscribeBudget` 并列，best-effort try/catch 包裹，不影响主流程。

## 影响

- 审计目录新增 `agent-session.log`（per worker-run），与 `worker.log` 并列。
- e2e 测试走 `stubSessionFactory`，不触发此持久化（无诊断需求）。
