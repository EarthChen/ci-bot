# G4: 每项目独立 worker 的并发模型

> **wayfinder:grilling** · 状态: ✅ closed · 类型: HITL（需用户在线，/grilling）· assignee: 当前 session
>
> **Blocked by**: R1（已 closed，解锁本票）
>
> **Resolution**: 每项目独立 worker 并发模型已定。核心约束: R1 证实 Claude SDK 四条泄漏通道须显式配。
>
> ## 子决策
>
> 1. **worker 供给**: **按需 spawn** — GitLab webhook 事件来 → bot 主进程 spawn 一个 worker 子进程(跑 G2 pipeline 后退出)。无事件零占用。与 G2 单 session 形态天然对齐。冷启动延迟靠 shallow clone + 预热镜像 + 容器缓存缓解。
> 2. **触发源**: **Pipeline 事件(pipeline 级, 非 job 级)** — pipeline 终态(failed)才触发, 一个 pipeline 只触发一次, 同 pipeline 多 job 天然聚成一次修复, **无需去重合并逻辑**(用户修正: 听 pipeline 事件而非 job 事件, 简化并发)。接受 pipeline 终态延迟(大多数单测失败会快速终止 pipeline)。
> 3. **跨 pipeline 过期处理**: **串行队列, 跑完当前后取最新** — 同项目 FIFO, worker 跑完当前 pipeline 后取队列最新 pipeline; 旧 commit 修复完 MR 标注"基于旧 commit 请 rebase/丢弃" + 钉钉告知过期。不打断(不白烧 turn)。不合并跨 commit(各自独立, 串行)。
> 4. **隔离配置**: **全显式配置** — 每 worker 启动时一次性配好 R1 四条泄漏通道: `settingSources:[]` + `CLAUDE_CONFIG_DIR=<per-worker>` + `CLAUDE_CODE_DISABLE_AUTO_MEMORY=1` + `cwd=<per-worker 项目 clone>`。bot 代码层做, 不依赖 SDK 默认。
> 5. **背压**: **全局并发上限 N + 超出排队** — 设全局 worker 并发上限 N(具体值依赖 G5 沙箱 + G7 部署资源, G4 先标依赖), 超出的事件进全局 FIFO 队列等待。不丢弃(符合"不漏修")。队列过长时钉钉告警(人工可介入)。
>
> ## Worker 生命周期
>
> ```mermaid
> sequenceDiagram
>   participant GW as GitLab Webhook
>   participant Bot as Bot 主进程
>   participant Q as 全局队列
>   participant W as Worker 子进程
>   participant SDK as ClaudeSDKClient
>   Bot->>Q: pipeline failed 事件入队
>   Q->>W: 当前并发 < N, 出队 spawn
>   W->>W: 配 R1 四条隔离 + cwd + 预算
>   W->>SDK: 起 ClaudeSDKClient(max_turns+max_budget_usd)
>   SDK-->>W: 跑 G2 pipeline(诊断+修复+验证)
>   W->>Bot: 结果(开 MR/转人工) + 退出
>   Note over Q: 若并发 >= N, 等待; 过长钉钉告警
> ```
>
> ## 待定/依赖
>
> - 全局并发上限 N 的具体值: 依赖 G5(沙箱资源) + G7(部署机器资源) 落地后定。G4 先定机制(上限+排队), 不定数值。
> - 项目级配置(每项目的 GitLab repo/token/模型偏好)加载机制: 依赖 G7 部署形态。
>
> Resolution 详情存本票; 无单独 brief 文件(并发模型设计即产出)。

## Question

用户已选"每项目独立 worker 并行"。本 ticket 把它 grilling 到 spec 级别：worker 怎么供给、怎么调度、怎么隔离、资源怎么管。

1. **worker 供给**：长驻 pool（每项目常驻一个 worker 进程）vs 按需 spawn（事件来才起）？worker 进程/线程/SDK-agent-instance 哪一级？
2. **隔离**：每 worker 独立 git worktree/clone（避免并发写冲突）、独立 context/预算、独立模型配额。项目级配置怎么加载。
3. **状态与去重**：同一项目短时间内多次失败事件——去重/合并/排队？worker 正在修时新事件怎么处理（忽略、排队、打断）？
4. **背压**：worker 数上限、内存/CPU/模型配额耗尽时的拒绝策略。

## 产出

并发模型设计（供给/隔离/调度/背压），含一项目同时多失败的处理规则。归档 `research/g4-concurrency.md`。
