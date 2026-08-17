# Human Decision-Driven Session Resume

> Triage: `ready-for-agent`

## Problem Statement

当 CI 自愈 bot 的 agent 无法区分"测试错误"与"源码修改错误"时，当前行为是直接转交人工并销毁所有工作现场（worktree、session、cwd）。人工收到转交通知后，只能自己去修源码或手动重启修复流程——bot 之前积累的诊断上下文全部丢失，人工无法把决策反馈给 bot 让它继续执行。

## Solution

为"agent 主动 escalated 且带 diagnosis"的转交增加**待决策状态**：bot 冻干现场（保留 worktree + session + cwd），在路由群发送带决策 id 的结构化通知；人工通过 `/heal <id> test|prod|drop [备注]` 命令回复决策；bot 跨进程恢复原 session，注入决策上下文，继续走原修复流水线。判定不解锁 G3 边界，人工介入仅限一轮。

## User Stories

1. As a 值班工程师, I want 在路由群看到带决策 id 的转交消息, so that 我能立即识别这是可决策的转交而非纯通知
2. As a 值班工程师, I want 用 `/heal <id> test` 命令告诉 bot "按测试问题继续修", so that bot 能复用已有诊断上下文继续修复而不从头开始
3. As a 值班工程师, I want 在 test 决策后附自由文本备注说明 spec 规定的正确行为, so that agent 能按正确语义修复测试而非固化当前 bug
4. As a 值班工程师, I want 用 `/heal <id> prod` 确认这是源码 bug, so that bot 记录关闭该事件、我自行修源码，不再浪费 bot 预算
5. As a 值班工程师, I want 用 `/heal <id> drop` 丢弃无意义的失败, so that bot 立即清理现场、不占 TTL 等待时间
6. As a 值班工程师, I want 转交消息里包含可直接复制的完整命令模板, so that 我不需要手敲 id 减少出错
7. As a 值班工程师, I want 无效 id / 已消费 id 被拒绝并回用法提示, so that 我不会误以为决策生效了
8. As a 值班工程师, I want 私聊里的 `/heal` 被拒绝, so that 决策只在责任群内发生、审计可追溯
9. As a 值班工程师, I want 同项目新 pipeline 到达时旧决策自动作废, so that 我不会在过时 sha 上做出无效决策
10. As a 值班工程师, I want 决策超时（24h）后自动关闭并收到通知, so that 我不会忘记处理导致现场无限期占用磁盘
11. As a 值班工程师, I want 恢复执行后 agent 再次转交时直接终局, so that 不会出现人机拉锯无限循环烧预算
12. As a 值班工程师, I want bot 重启/发版后 pending 决策仍可恢复, so that 运维窗口不会丢失待处理的人工决策
13. As a 值班工程师, I want 所有 escalated 通知都走项目路由到同一群, so that 项目的失败与转交消息不分裂在两个群
14. As a 值班工程师, I want 决策者的 staffId/nick 被记录到审计, so that 事后复盘能追溯谁做了什么决策
15. As a 值班工程师, I want 恢复执行的 token 预算独立计算, so that 不会因为首轮已消耗预算导致恢复立即超限
16. As a 值班工程师, I want 恢复执行仍受 G3 约束（只改测试/文档）, so that 我的 test 决策不会被误解为授权改生产代码
17. As a 值班工程师, I want `/help` 能看到 `/heal` 的用法, so that 我不需要记忆命令格式
18. As a 平台维护者, I want 决策状态存 SQLite 而非内存, so that 状态跨重启持久且查询高效
19. As a 平台维护者, I want 现场保留有 TTL 且由主进程定期清扫, so that 异常退出的决策不会永久占用磁盘
20. As a 平台维护者, I want 决策链深度和累计 token 记录在审计, so that 我能监控人工介入的频率和成本

## Implementation Decisions

### 决策枚举与语义

- 三值决策：`test` | `prod` | `drop`
- `test`：消除 agent 不确定性，授权继续按测试问题修复（仅测试/文档），备注作为 spec 正确行为注入 session
- `prod`：确认源码 bug，bot 记录 outcome=`human_confirmed_prod`，清理现场，群通知"已确认源码 bug，请人工修复"
- `drop`：丢弃，outcome=`dropped`，清理现场
- 自由文本备注可选，仅 `test` 决策时注入 session prompt

### G3 边界不变

- 恢复执行仍走 `validatePatchPaths`，`src/main` 禁碰
- `prod` 决策不触发任何代码修改
- 本需求不引入任何 G3 解锁机制

### 决策作用域

- 仅"agent 主动 escalated 且带 diagnosis"进入待决策
- class 5 早筛、bot 故障（预算超限/JSON 解析失败/session 异常）保持纯转交，不进待决策
- 区分方式：AgentResult 来源标记（agent 自身结构化输出 vs runner 生成的 escalateBudget/escalateError）

### 命令协议

- 格式：`/heal <id> test|prod|drop [自由文本备注]`
- id 强制，无 id 或 id 错误拒绝并回用法
- 群级授权：该群任何成员可决策，审计记录回复者
- 私聊拒绝
- 已消费/已终态 id 拒绝

### 决策 ID

- 形态：`D-<pipelineId>-<rand4>`
- 同 pipeline 多次转交不撞 id
- 由主进程在注册决策时生成

### 状态机

```
awaiting_decision ──/heal test──▶ resumed ──▶ mr | escalated(终局) | failed
       │                              ▲
       ├──/heal prod──▶ closed        │ (同一 worker 内 MR CI 重试仍走 repairFixed)
       ├──/heal drop──▶ dropped       │
       ├──TTL 到期──▶ expired         │
       └──新 pipeline 到达──▶ invalidated
```

- 二次转交 = 终局，不生成新决策（一轮介入限制）

### 现场保留策略

- 可决策 escalated 时跳过 worktree/cwd/branch 清理
- 保留内容：`work/<uuid>/`（含 `repo/` worktree + `.pi-agent/` session + ci-log.txt 等）+ bare 仓库分支
- 终态（closed/dropped/expired/invalidated/恢复完成）→ 立即清理
- TTL 默认 24h，`CIHEAL_DECISION_TTL_MS` 环境变量可配

### 通知路由变更

- 所有 escalated 通知改走 ProjectRouter（与 webhook 失败播报同群）
- 带决策的转交消息体：diagnosis 摘要 + 决策 id + `/heal` 命令模板 + 过期时间
- worker 侧需注入路由能力（当前 worker notifier 只有固定 conversationId）
- 非决策 escalated 也走路由（一致性），但不附决策字段

### 恢复执行机制

- 新 worker spawn，task 类型 = resume（扩展 `CIHEAL_WORKER_TASK` schema）
- `SessionManager.open(<保留的 session.jsonl>)` 重建会话
- 决策 + 备注作为新 user message 注入
- 走原 pipeline 后半段：extractPatch → G3 validate → verifyTestsGreen → createMR → notify
- Scheduler enqueue，key=projectId（与同项目新事件串行）
- 预算独立 200k，audit 记录累计链

### 失效规则

- 同 projectId 新 pipeline 到达 → 旧 awaiting_decision 自动 invalidated + 清理 + 群通知
- 决策已消费/已终态 → 重复 `/heal` 拒绝

### 持久化

- 决策状态存 SQLite（DATA_ROOT 下独立 db 文件，复用 better-sqlite3 WAL 模式）
- 表结构：decision_id, pipeline_id, project_id, event_json, cwd_path, session_path, branch, status, created_at, expires_at, decided_by, decision_value, remark, decided_at
- 现场在 `work/` 持久盘
- TTL 清扫由主进程定时器驱动（复用现有 retention 机制）

### 模块划分

- `src/decision/store.ts` — SQLite 决策状态存储（CRUD + TTL sweep + invalidation）
- `src/decision/heal-command.ts` — `/heal` 命令解析与执行入口
- `src/decision/lifecycle.ts` — TTL sweep + invalidation hook
- `src/pipeline/run-resume.ts` — 恢复编排（runRepair 的 resume 变体）
- `src/notify/escalation-notifier.ts` — 统一 routed escalation 通知
- `src/worker/entry.ts` — 新增 resume task 分支
- `src/main.ts` — wire heal command + TTL timer + router 注入 worker
- `config/command-help.json` — `/heal` 帮助文案
- `docs/adr/0005-escalation-scene-retention.md` — ADR
- `CONTEXT.md` — 新增领域词汇

### AgentResult 来源标记

- 在 AgentResult escalated 类型中新增 `source: "agent" | "runtime"` 字段
- result-parser 产出 `source: "agent"`
- real-runner 的 escalateBudget/escalateError 产出 `source: "runtime"`
- runRepair 据此判断是否可决策

### Worker 路由能力注入

- 当前 worker 的 DingTalkNotifier 只有固定 conversationId
- 新增 `RoutedDingTalkNotifier`：接受 ProjectRouter + routeStore，send 时按 event.projectId 路由
- worker entry 在 real 模式下使用 RoutedDingTalkNotifier
- 或：worker 不发送 escalated 通知，由主进程 scheduler 层统一发送（更干净，避免 worker 持有路由状态）
- **推荐后者**：worker 返回 outcome + event，主进程根据 outcome 类型决定通知方式和路由

## Testing Decisions

### 什么是好的测试

- 只测外部行为：命令输入 → 通知输出 / 状态变更 / 现场清理
- 不测内部实现：不测 SQL 语句、不测 SessionManager 内部
- 端到端验证恢复链路：真实子进程 + fake deps，验证 session 确实被恢复且决策被注入

### 测试接缝（6 复用 + 1 新增）

1. `AgentRunner` 接口 — StubAgentRunner 支持 resume 模式
2. `DingTalkNotifier` / `InMemoryDingTalkNotifier` — fake 模式验证 routed 通知内容
3. `WebhookRouteStore` 范式 — DecisionStore 同模式测试
4. `SubprocessWorkerManager.keepWork` — 验证现场保留/清理
5. `Scheduler.enqueue` — resume enqueue 同接口
6. e2e 完整链路 — 真实子进程 + fake deps
7. **`DecisionStore`（新增）** — CRUD + TTL sweep + invalidation

### 各模块测试策略

- **DecisionStore**：unit test，SQLite 内存模式，覆盖 CRUD/TTL/invalidation/并发安全
- **heal-command**：unit test，mock store + notifier，覆盖有效/无效/已消费/私聊/权限场景
- **lifecycle**：unit test，mock store + clock，覆盖 TTL sweep + invalidation 触发
- **run-resume**：integration test，StubAgentRunner + fake glab/dingtalk，验证 session 恢复 + pipeline 后半段
- **escalation-notifier**：unit test，mock router + sender，验证路由 + 消息体格式
- **e2e**：完整链路测试，覆盖验收标准 1-7（见共识摘要第 11 节）
- **重启安全**：integration test，写入 pending 决策 → 模拟重启 → 验证仍可 /heal

### Prior art

- `tests/notify/route-command.test.ts` — 命令解析 + fake reply 模式
- `tests/e2e/` — 真实子进程 + env-switch DI + sidecar JSON 验证
- `tests/agent-runtime/scheduler.test.ts` — enqueue/dedupe 测试
- `tests/notify/route-store.test.ts` — SQLite store 测试范式

## Out of Scope

- G3 边界解锁（人工授权改 src/main）
- 多轮人工介入（决策链 > 1）
- DingTalk 卡片消息按钮交互（ActionCard / TOPIC_CARD_CALLBACK）
- 决策 id 省略（隐式上下文路由）
- 私聊决策支持
- staffId 白名单权限控制
- 决策统计仪表盘 / metrics 聚合查询
- 跨项目决策批量操作
- 恢复执行的增量预算（继承首轮已消耗量）
- 非 agent-initiated escalated 的决策支持（class 5 / bot 故障）

## Further Notes

- **ADR-0003** 应记录：从 per-event 临时 worker 到部分 worker 长生命周期的架构转变、磁盘 vs 可恢复性权衡、一轮介入限制的 rationale
- **CONTEXT.md** 需新增词汇：Human decision、Awaiting decision、Resume、Decision invalidation、Retained scene
- **DingTalk Stream 限制**：TOPIC_ROBOT 回调不携带 quoteMessageId，因此无法靠"直接回复消息"自动关联决策 id，必须显式 id
- **Worker 通知架构变更**：推荐 worker 不发送 escalated 通知，由主进程统一发送——这改变了当前 worker 自通知的模式，需在 ADR 中记录
- **TTL 清扫频率**：建议每分钟一次（与现有 retention sweep 对齐），低开销
- **决策 store 与 route-store 的关系**：独立 db 文件（关注点分离），但复用同一 better-sqlite3 WAL 模式和测试范式
- **恢复执行的 worktree 分支**：保留原分支 `ci-self-heal/<ref>-<sha8>`，resume worker 直接使用，不重建
- **预算累计审计**：audit-trace 新增 `cumulativeTokens` / `chainDepth` 字段，metrics.jsonl 同步追加
