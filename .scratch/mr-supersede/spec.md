# MR 更新取代（Supersede）与 Session 延续

> Triage: `ready-for-agent`

## Problem Statement

一次修复执行时间很长（实测 30-50 分钟），而用户经常在此期间对同一 MR 继续提交。当前行为在这个场景下全面失效：

1. **排队过期执行**：队列只按 pipeline-id 幂等，同一 MR 连推 N 次 = N 个事件全部排队、逐个对着已被取代的旧 sha 跑完整修复，纯烧预算。
2. **运行中无感知**：agent 运行期间用户推了新提交，worker 毫无感知，修复完成后照旧对旧 sha 开 MR——产物轻则 conflict、重则语义错误。
3. **修复 MR 堆积**：bot 修复分支名含 sha（`ci-self-heal/<ref>-<sha8>`），新提交 = 新分支 = 同一源 MR 上并存多个 bot 修复 MR，review 列表越堆越多。
4. **知识丢失**：session 存档条件只认「带 MR 成果的终局」，被取代/被打断/失败/转交的运行诊断知识全部丢弃，下次 pipeline 冷启动。
5. **决策误伤**：决策作废按 project 维度——MR-B 的新 pipeline 会作废 MR-A 的待决策。
6. **用户已自修仍起 agent**：用户新提交已把 CI 跑绿，bot 依然照常起 agent。

## Solution

把 **MR 确立为修复生命周期的单位**，引入 supersede 语义 + session 延续：用户对同一 MR 的新提交天然作废旧 sha 上的 bot 工作，但 bot 的**诊断知识通过 session 延续**，而非丢弃重来。

新 pipeline 到达时按同 MR 状态分流：运行中 → `steer()` 注入活 session（agent 自行更新代码）；排队中 → 合并只留最新；awaiting_decision 冻干 → 先存档再作废清现场；已归档 → reopen + compact + continue；无历史 → 全新 session。**session 寿命 = MR 寿命**（MR merge/close 才清理）。

配套：一个源 MR 至多一个 bot 修复 MR（分支名按源 MR 收敛，GitLab 为事实源）；createMR 前终局新鲜度闸门；出队前绿灯短路；决策作废收窄到 MR。worker/session 分层不变（event : worker : session = 1:1:1，per-event 子进程隔离不动）——复用的是 jsonl 文件的寿命，不是进程的寿命。

## User Stories

**运行中取代（steer）**

1. As an MR 作者, I want 修复运行中我推的新提交立即通知正在工作的 agent, so that agent 在自己的上下文里处理更新而不是对旧代码开出过期 MR
2. As an MR 作者, I want 连续多次推送只产生一条带最新 sha 的通知（仅在前一条通知未送达时合并）, so that agent 不对中间态 sha 做重复的 fetch-比对-重做
3. As an MR 作者, I want agent 收到更新通知后自行决定保留还是放弃当前改动（patch 迁移或 reset 重做）, so that 新提交只碰无关文件时已完成的工作不被无谓丢弃
4. As an MR 作者, I want steer 通知携带 old sha→new sha 与变更文件清单, so that agent 能判断当前工作与更新的冲突面再决定保多少
5. As an MR 作者, I want 我的新提交已把 CI 跑绿时运行中的 agent 收到「可以收尾」的通知, so that 剩余预算不被浪费
6. As a bot 维护者, I want agent 看到的 sha 序列单调收敛到真实最新（可跳过中间态、永不落后、永不静默丢失）, so that 取代语义有可验证的不变式

**排队合并**

1. As an MR 作者, I want 同一 MR 排队的多个 pipeline 只保留最新一个, so that 过期修复不会串行跑 N 遍
2. As an 值班工程师, I want 被合并掉的事件记入审计并在群里留一句「已被更新的 pipeline 取代」, so that pipeline 的消失不是静默的

**Session 延续（寿命 = MR 寿命）**

1. As an MR 作者, I want 上次终局（开出 MR / 部分修复转交 / 纯转交 / 失败）后同 MR 的下一个 pipeline 复用同一 session, so that 诊断知识不丢、不冷启动
2. As an MR 作者, I want awaiting_decision 现场被新 pipeline 作废时先存档 session 再清现场, so that 后续修复能 reopen 继续而不是从零开始
3. As an MR 作者, I want 复用的 session 被明确告知「MR 已更新到新 commit、不得沿用旧诊断」, so that 陈旧记忆不误导新修复
4. As an 值班工程师, I want session 存档在 MR 合并/关闭时清理（叠加 LRU 兜底）, so that 存档不无限堆积
5. As a bot 维护者, I want session reopen/compact/continue 任何环节失败都降级为全新 session 且不阻断修复, so that 复用机制永远不是修复的故障源

**修复 MR 收敛**

 1. As a reviewer, I want 一个源 MR 至多存在一个 bot 修复 MR, so that review 列表不堆积过期 MR
 2. As a reviewer, I want 后续修复原地 push 更新同一个 bot MR, so that 我看到的是最新完整 diff 而不是增量碎片
 3. As a reviewer, I want 上一个 bot MR 被合并后新失败仍能自动开新修复 MR, so that 修复能力不因历史合并而中断
 4. As a reviewer, I want 我关闭 bot MR 后 bot 重开新 MR 时注明「上一个被关闭」, so that 我知道 bot 感知了我的拒绝且拒绝语境可追溯
 5. As a bot 维护者, I want bot MR 是否存在以查询 GitLab（按 source_branch）为准而非本地状态机, so that 人工操作、bot 重启、webhook 丢失都不造成状态漂移

**终局闸门与绿灯短路**

 1. As an MR 作者, I want createMR 前 bot 校验工作基线对照 MR 最新 HEAD、被取代则丢弃成果不开 MR, so that 即使 steer 没来得及处理也不会提交过期修复
 2. As an 值班工程师, I want 新鲜度闸门只拦 MR 产物、不影响转交类终局, so that 诊断不确定的转交照常到达决策流程
 3. As an MR 作者, I want 出队执行前复查该 MR 最新 pipeline 状态、已绿直接跳过, so that 我自己修好之后 bot 不再起 agent
 4. As an 值班工程师, I want 绿灯跳过同样记审计并留群通知尾注, so that 跳过行为可观测

**决策作废收窄**

 1. As an 值班工程师, I want MR-B 的新 pipeline 不作废 MR-A 的待决策, so that 决策不被跨 MR 误伤
 2. As an 值班工程师, I want 同 MR 新 pipeline 到达仍作废其待决策（先存档现场 session）, so that 我不在过期代码上做决策

**可观测与兼容**

 1. As a bot 维护者, I want 审计记录 supersede 事件链（哪个 pipeline 取代哪个、steer 何时送达、闸门是否拦截）, so that 时间线可复盘
 2. As a bot 维护者, I want `ci-self-heal/*` 源分支的 bot 回流 pipeline 继续被忽略, so that 新机制不引入 bot 修自己 MR 的循环
 3. As an MR 作者, I want 无 MR 上下文的 push pipeline 保持以 ref 为 serial key 的现行行为, so that 非 MR 场景零回归
 4. As a bot 维护者, I want worker/session 分层保持 event:worker:session = 1:1:1 与 per-event 子进程隔离, so that 隔离模型、预算监控、IPC 进度上报的粒度语义不变

## Implementation Decisions

1. **新 pipeline 到达状态机**（同 serialKey）：
   - 运行中 → steer 注入活 session（见 2）
   - 排队中 → 合并只留最新，被挤掉的入审计 + 群通知
   - awaiting_decision → 存档 session → 作废决策、清现场 → 新 pipeline 走 reopen
   - 已归档 → `SessionManager.open` + `compact()` + continue（ADR-0007 机制，存档条件放宽）
   - 无历史 → 全新 session
2. **Steer 机制**：主进程→worker 信号复用现有 IPC 管道（`CIHEAL_WORKER_IPC`）的反向通道；worker 收到后对自己的活 session 调 `AgentSession.steer(text)`。steer 消息内容：old sha→new sha、变更文件清单/diff 摘要、处置指令（fetch→比对→patch 迁移或 reset，agent 自裁）；若新 pipeline 已绿，附「可收尾」。合并语义：仅当前一条 steer 未送达时，新事件不叠加、把待送达内容更新为最新 sha；送达信号以 SDK `queue_update` 事件判定。**不变式：agent 看到的 sha 序列单调收敛到真实最新，可跳过中间态，永不落后、永不静默丢失。**
3. **Session 寿命 = MR 寿命**：存档触发条件从「带 MR 成果的终局」放宽为**所有终局 + 决策作废时**；存档键、LRU（上限 32）、latest-wins 不变；清理挂 onMrTerminal + LRU。复用入口统一为 open + compact + continue，prompt 强制声明「MR 已更新到新 commit、不得沿用旧诊断」；任何环节失败降级全新 session，不阻断修复。
4. **修复 MR 恒一**：修复分支名改为按源 MR 稳定（`ci-self-heal/<sourceBranch>`，去掉 sha 钉死）。修复时按 `source_branch` 查询 GitLab：open → push 原地更新（force-push/rebase 后 diff 自动按最新 target 重算）；merged / closed / 不存在 → 新开 MR。不建本地状态机。close 后重开在 MR 描述与群通知注明「上一个修复 MR !N 被关闭，本次为新尝试」。
5. **终局新鲜度闸门**：createMR 前校验工作基线对照 MR 最新 HEAD——被取代则丢弃成果、不开 MR、发通知、记审计。确定性闸门，与 agent 自律两层独立；转交类终局不受影响。
6. **绿灯短路**：出队执行前复查该 MR 最新 pipeline 状态（glab-client 已有能力），已绿则跳过修复（审计 + 群通知尾注）。运行中变绿走 steer 通知路径（见 2）。
7. **决策作废收窄**：作废范围从按 project 改为按 MR；awaiting_decision 现场作废时先存档 session 再清现场。
8. **分层不动**：event : worker 进程 : session = 1:1:1，per-event 子进程隔离（G4）不变。明确否决两个替代方案：长驻 per-MR worker（隔离模型崩塌、空闲驻留占资源、并发槽位计数复杂化）；一个 worker 持有多个并发 session（预算/IPC/审计粒度语义模糊）。session 复用指 jsonl 文件寿命，不是进程寿命。
9. **词汇表同步**：CONTEXT.md 的 *Decision invalidation* 词条「same project」改为「same MR」；新增 *Supersede* 词条（新提交对同 MR 旧 sha 上 bot 工作的取代语义）。
10. **实现前 spike（两项，结果可能微调实现但不改不变式）**：
    - steer 打断长时工具调用（如 mvn 跑到一半）的精确时点——若 SDK 实际为「turn 边界注入」，实现退化为边界注入，不变式仍成立；
    - 待送达 steer 的内容替换/合并姿势（`queue_update` 事件作送达信号是否可靠）。

## Testing Decisions

**好测试的标准**：只测外部行为——webhook 进 → 可观测产物出（sidecar JSON、审计 trace、群通知文本、scheduler 状态），不测内部调用序列。每个测试编码 WHY：取代语义的价值是「不烧过期预算、不提交过期 MR」，测试必须在这些业务后果上失败。

**零新 seam**：全部走现有 env-switch DI（`CIHEAL_AGENT_MODE=stub` / `CIHEAL_GLAB_MODE=fake` / `CIHEAL_STUB_*`）+ sidecar JSON + 已有测试目录。主→worker steer 信号复用现有 IPC 管道反向通道；stub session 扩展记录 steer 调用。

- **单元测试（现有文件扩展）**：
  - scheduler 测试：同 serialKey 排队合并只留最新 + 被挤掉事件的审计/通知；出队前绿灯短路跳过
  - lifecycle 测试：决策作废收窄到 MR（跨 MR 不作废）；作废时先存档 session
  - mr-session-store 测试：存档条件放宽——escalated（无 MR）/failed/决策作废均存档
  - run-repair 测试：终局新鲜度闸门——基线过期丢弃不开 MR；基线最新照常开 MR
- **e2e（新增 supersede 用例）**：
  - 运行中第二个 webhook（新 sha）→ stub session 收到 steer、内容含最新 sha
  - 运行中连推 3 次 → 只有一条 steer 且带最终 sha
  - 第二个 pipeline 已绿 → 运行收尾/出队跳过
  - 归档终局后同 MR 新 pipeline → reopen 延续（审计有复用记录）
  - bot MR 收敛：fake glab sidecar 断言同名分支、MR 只创建一次、后续为 push 更新
- **Prior art**：`tests/e2e/resume.test.ts`（跨进程 reopen）、`human-decision.test.ts`（现场保留/作废）、`stage-exclusion.test.ts`（跳过 + 通知尾注模式）、`tracer-bullet.test.ts`（全链路骨架）；fake glab sidecar 约定（`glab-mr-creates.json` 等）。

## Out of Scope

- 长驻 per-MR worker 进程、一 worker 多并发 session（均已否决，见 Implementation Decisions 8）
- bot MR 自动合并（红线不变：所有 MR 强制人工 review）
- token 预算策略调整（dev `BOT_BUDGET_TOKENS=900M` 实际禁用预算的问题单独立项）
- G3 diff 白名单规则变更（agent 自裁代码更新不授予白名单外权限）
- `.m2` 并发安全改造（已决策：共享、接受低概率写冲突）
- 非 MR 场景（push pipeline）的新语义——仅保持现行 ref 回退
- playbook 修复策略调整（批量编辑条款已单独落地）

## Further Notes

- 本 spec 源自一轮 grilling 会话：Q1-Q13、修复 MR 收敛规则、worker/session 分层结论均已由用户逐项确认；云端 agent 平台（Codex cloud / Copilot coding agent / Devin 等）的「任务级隔离环境 + 无状态编排 + 日志式 session 持久化」模型与 bot 现行 1:1:1 分层同构，无需向长驻环境模型迁移。
- 伴随 ADR：实现时在 `docs/adr/0011`（supersede 与 MR 寿命 session）记录决策树与否决方案；`.scratch/ci-agent-fix/` 内 feature 级 ADR 为既有先例。
- 依赖的 SDK 事实（已核实于 pi-coding-agent 0.84.2）：`AgentSession.steer(text)` 运行中可注入；`streamingBehavior: "steer" | "followUp"`；`queue_update` 事件携带 steering 队列快照；`SessionManager.open/list` 支持按文件重开。
