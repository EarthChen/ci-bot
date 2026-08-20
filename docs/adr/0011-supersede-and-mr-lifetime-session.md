# Supersede 语义与 MR 寿命 Session

一次修复执行时间很长（实测 30–50 分钟），而用户经常在此期间对同一 MR 继续提交。旧行为在此场景下全面失效：

1. **排队过期执行**：同一 MR 连推 N 次 = N 个事件全部排队、逐个对着已被取代的旧 sha 跑完整修复，纯烧预算。
2. **运行中无感知**：agent 运行期间用户推了新提交，worker 毫无感知，修复完成后照旧对旧 sha 开 MR——产物轻则 conflict、重则语义错误。
3. **修复 MR 堆积**：bot 修复分支名含 sha（`ci-self-heal/<ref>-<sha8>`），新提交 = 新分支 = 同一源 MR 上并存多个 bot 修复 MR。
4. **知识丢失**：session 存档条件只认「带 MR 成果的终局」，被取代/被打断/失败/转交的运行诊断知识全部丢弃。
5. **决策误伤**：决策作废按 project 维度——MR-B 的新 pipeline 会作废 MR-A 的待决策。
6. **用户已自修仍起 agent**：用户新提交已把 CI 跑绿，bot 依然照常起 agent。

## 决策

把 **MR 确立为修复生命周期的单位**，引入 supersede 语义 + session 延续 + 修复 MR 恒一。worker/session 分层不变（event : worker : session = 1:1:1，per-event 子进程隔离不动）——复用的是 jsonl 文件的寿命，不是进程的寿命。

### Supersede 三层

1. **排队合并**：同 serialKey 排队事件只保留最新；被挤掉的入审计 + 群通知。
2. **运行中 steer**：主进程→worker IPC 反向通道；worker 对活 session 调 `AgentSession.steer(text)`。注入时点 = 当前 assistant turn 的全部 tool 执行完毕之后、下一次 LLM 调用之前。未送达窗口内连推合并为 `clearQueue()` + `steer(latest)`。终局新鲜度闸门兜底 steer 延迟。
3. **终局新鲜度闸门**：createMR 前校验工作基线 vs MR 最新 HEAD——被取代则丢弃成果、不开 MR；转交类终局不受影响。
4. **绿灯短路**：出队执行前复查该 MR 最新 pipeline 状态，已绿则跳过修复；运行中变绿走 steer 通知路径。

### Session 寿命 = MR 寿命

存档触发条件从「带 MR 成果的终局」放宽为**所有终局 + 决策作废时**；存档键、LRU（上限 32）、latest-wins 不变；清理挂 onMrTerminal + LRU。复用入口统一为 open + compact + continue，prompt 强制声明「MR 已更新到新 commit、不得沿用旧诊断」；任何环节失败降级全新 session，不阻断修复。

### 修复 MR 恒一

修复分支名改为按源 MR 稳定（`ci-self-heal/<sourceBranch>`，去掉 sha 钉死）。修复时按 `source_branch` 查询 GitLab：open → push 原地更新；merged / closed / 不存在 → 新开 MR。不建本地状态机。

### 决策作废收窄

作废范围从按 project 改为按 MR；awaiting_decision 现场作废时先存档 session 再清现场。无 mrIid 时回退 project 维度。

## 否决方案

### 长驻 per-MR worker

一个 MR 对应一个长驻 worker 进程，新 pipeline 直接复用同一进程内的活 session。

**否决理由**：隔离模型崩塌（per-event cwd/env 隔离、预算监控、IPC 进度上报粒度全部失效）；空闲 MR 驻留占资源；并发槽位计数复杂化（worker 生命周期与 MR 生命周期纠缠）。

### 一 worker 多并发 session

单个 worker 子进程同时持有多个 MR 的并发 session。

**否决理由**：预算/IPC/审计粒度语义模糊（一个 worker 的 token 消耗归属哪个 MR？steer 信号路由到哪个 session？）；与现有 1:1:1 分层和 per-event 子进程隔离原则冲突。

## 新 pipeline 到达状态机（同 serialKey）

| 当前状态 | 行为 |
| --- | --- |
| 运行中 | steer 注入活 session |
| 排队中 | 合并只留最新，被挤掉的入审计 + 群通知 |
| awaiting_decision | 存档 session → 作废决策、清现场 → 新 pipeline 走 reopen |
| 已归档 | `SessionManager.open` + `compact()` + continue |
| 无历史 | 全新 session |

## 风险与缓解

- **Steer 延迟**：长时 tool 执行期间无法立即注入。缓解：turn 边界注入 + 终局新鲜度闸门兜底。
- **Stale-diagnosis anchoring**：复用 session 可能锚定旧诊断。缓解：强制新 commit 声明 + 新鲜意图判定 + G3 闸门 + 人工 MR review（继承 ADR-0007 缓解链）。
- **Steer 丢失**：session dispose/abort 时未送达 steer 丢失。缓解：重置 pending + 审计 `steerLost`；终局闸门兜底。

## 后果

- session 复用减少冷启动，诊断知识在 MR 生命周期内延续而非丢弃重来。
- MR 列表不堆积过期 bot 修复 MR（分支名收敛 + 原地 push 更新）。
- 预算不烧过期修复（排队合并 + 绿灯短路 + steer 取代）。
- 决策不被跨 MR 误伤（作废收窄到 MR 维度）。
- `DATA_ROOT/mr-sessions` 存档频率上升（所有终局 + 决策作废均触发），LRU 32 槽 + onMrTerminal 清理维持有界。
- 审计新增 supersede 事件链（哪个 pipeline 取代哪个、steer 何时送达、闸门是否拦截）。
