# CI Self-Heal Bot

## Project

CI 单测自愈 bot：headless 长驻 TS 服务，监听 GitLab pipeline 失败 webhook → 共享 Pi Agent Runtime 驱动 agent 诊断失败根因 → 修复测试/文档（单测失败绝不碰 `src/main`；static-analysis/Checkstyle 可修 MR diff 内文件，ADR-0004）→ 开 MR 供人工 review → 钉钉推送结果。可决策的转交（agent 诊断不确定）会冻干现场，人工在群内 `/heal` 决策后 bot 跨进程恢复原 session 继续修复；确定性失败 stage（如 format）经 `CIHEAL_SKIP_STAGES` 排除，不进修复。

> [推断] "CI 自愈" 是当前唯一 vertical agent；架构已抽离出共享 Agent Runtime（`src/agent-runtime`），后续 vertical agent 复用同一运行时。

## Stack

- **语言/运行时**：TypeScript（ES2022, NodeNext），Node ≥ 20（CI 用 22）
- **SDK**：`@earendil-works/pi-coding-agent` 0.84.0（agent 能力 + skill 加载 + session 管理）
- **Web 框架**：Fastify 5（webhook 接收）
- **日志**：pino 9 + pino-roll（结构化 JSON）
- **钉钉**：`dingtalk-stream` SDK（Stream 模式：主进程 WebSocket 接收 + SDK API 推送）
- **存储**：better-sqlite3（动态群路由 `group-routing.db` + 人工决策 `decisions.db`，均 WAL；原生模块，已入 `allowBuilds` 审批）
- **测试**：vitest 2（forks singleFork，子进程测试隔离）
- **构建**：tsc 直出 `dist/`（无 bundler）
- **包管理**：pnpm 11（lockfile 提交；`allowBuilds` 已声明）

## Commands

```bash
pnpm install          # 安装依赖（非交互用 ./node_modules/.bin/tsc|vitest 绕过 onlyBuiltDependencies 审批）
pnpm build            # tsc -p tsconfig.json → dist/
pnpm typecheck        # tsc --noEmit（CI 门禁）
pnpm test             # vitest run（全量）
pnpm test:watch       # vitest watch
pnpm dev              # tsx src/main.ts（开发模式）
pnpm start            # prestart 自动 build；node --enable-source-maps dist/main.js（生产）
pnpm audit           # pnpm audit --prod
pnpm metrics          # node scripts/metrics-summary.mjs
```

## Architecture

```text
src/
  main.ts                  # 入口：config + Fastify + StreamDingTalkBot/Notifier + scheduler + decision lifecycle（TTL sweep）
  config/
    index.ts               # .env 解析 + 配置校验；必填 CIHEAL_BOT_ROOT / CIHEAL_PI_BASE_DIR（绝对路径）缺失即抛
    paths.ts               # DATA_ROOT 派生的全部可写路径（work/bare/audit/logs + 两个 SQLite db）
    retention.ts           # audit/scene 保留策略
  webhook/receiver.ts      # POST /webhook：IP allowlist → 限流 → X-Gitlab-Token 验签 → 路径穿越校验 → builds[] 解析 failedStages → 修复开关（query `repair=1|true`，缺参=纯播报）→ stage 排除/去重入队 → onNewPipeline hook（决策作废）→ 即时播报
  agent-runtime/
    scheduler.ts           # 调度：串行键=project+MR（同项目多 MR 可并发）+ 全局 BOT_CONCURRENCY 封顶，pipeline-id 幂等去重 + 崩溃自警；可决策转交注册决策；enqueueResume（决策恢复）；skipStages 排除；routed 转交/终局通知
    runtime.ts             # SharedAgentRuntime：Pi session 创建、模型策略、资源加载、token 预算监控、执行循环
  worker/
    manager.ts             # SubprocessWorkerManager：per-event spawn 子进程，cwd/env 隔离；decidable escalated 保留现场；cleanupScene/runResume
    entry.ts               # 子进程入口：env-switch DI + runRepair / runResumeWorker（mode 分叉）
    main.ts                # 子进程 bootstrap
  pipeline/
    run-repair.ts          # G2 编排：fetch CI log → class-5 早筛（仅依赖错）→ agent run → extractPatch → G3 校验 → MR 监控重试 → 钉钉；导出 isDecidableEscalation
    run-resume.ts          # 恢复编排：SessionManager.open 重建保留 session → 决策注入 → 复用 stage-3+ pipeline
    repair-outcome.ts      # 终局处理：通知 → audit trace（含 decisionId/chainDepth）→ worktree 清理
    worktree.ts            # 共享 bare clone + per-pipeline git worktree（agent 真实工作区）
  decision/
    store.ts               # DecisionStore（SQLite）：决策 CRUD + TTL sweep + invalidateByProject
    heal-command.ts        # /heal <id> test|prod|drop [备注] 群命令（claim-then-enqueue + 补偿回滚）
    lifecycle.ts           # onNewPipeline（新 pipeline 作废待决策 + 清现场 + 通知）+ startTtlSweep
  agent/
    ci-repair-definition.ts  # CI Repair 垂直 agent 的 AgentDefinition（buildPrompt / buildContinuePrompt / buildDecisionPrompt）
    real-runner.ts         # RealAgentRunner：委托 SharedAgentRuntime；run/continue/resume；session 文件发现（findSessionFile）
    model-selection.ts     # bot-owned 同族 provider/model 候选链（config/model-candidates.json + model-profiles.json）
    runner.ts / stub-session.ts  # AgentRunner 接口 + StubAgentRunner + e2e stub session
  agents/ci-repair/        # 垂直 agent 资源：APPEND_SYSTEM.md、skills/ci-self-heal-playbook/、result-parser.ts
  gitlab/glab-client.ts    # glab CLI 包装：fetchCiLog / fetchMrDiff / fetchMrPipelineStatus / createMr
  notify/
    dingtalk.ts / stream-dingtalk.ts  # DingTalkNotifier 接口 + InMemory（测试）+ SDK API 推送
    stream-bot.ts          # DingTalkStreamBot：主进程 WebSocket 接收 TOPIC_ROBOT
    escalation-notifier.ts # routed 转交通知（待决策消息带 /heal 模板）+ 二次转交终局通知
    pipeline-notification.ts  # CI 失败群即时播报模板（移植 code-review-bot）
    project-router.ts      # project → 群路由（五层：动态精确/通配 → 静态精确/通配 → default）
    route-store.ts         # SQLite 动态路由（webhook_routes 表；/route 写、resolve 直读）
    route-command.ts / help-command.ts / command-help.ts  # 群命令 /route、/help + 文案外置（config/command-help.json）
  types.ts / util/log.ts   # 领域类型（PipelineEvent.failedStages 等）+ pino logger
config/                    # model-candidates.json + model-profiles.json + group-routing.json + command-help.json（bot-owned，非敏感）
.pi/                       # bot 基础 settings.json（retry / skill-commands 全局策略）
tests/                     # agent-runtime / agent / config / decision / e2e / notify / pipeline / webhook / worker
```

> CI：`.github/workflows/ci.yml`（pnpm 11 + Node 22，checkout 含 fixture submodule `fixtures/repo`（ci-bot-fixtures，公开），物化 class1/2/3-failing-test 本地分支后跑 typecheck + test）。Git remote：`github.com/EarthChen/ci-bot`，默认分支 master。

## Conventions

- **ESM**：`type: module`，import 必须带 `.js` 扩展（NodeNext 解析）
- **缩进**：tab
- **DI via env-switch**：`CIHEAL_AGENT_MODE=stub|real`、`CIHEAL_GLAB_MODE=fake|real`、`CIHEAL_DINGTALK_MODE=fake|real`、`CIHEAL_SESSION_FACTORY=stub`、`CIHEAL_STUB_CI_LOG`、`CIHEAL_STUB_VERIFY`、`CIHEAL_WORKTREE_MODE=fake` —— 测试用 fake/stub，生产用 real
- **跨进程观测**：fake glab/dingtalk 把调用记到 cwd 下 sidecar JSON（`glab-mr-creates.json` / `dingtalk-sent.json` / `verify-calls.json`），父测试读回
- **worker 隔离**：per-event 临时 cwd + 独立 `PI_CODING_AGENT_DIR`（=`.pi-agent`）+ 独立 env；worktree 在 `<cwd>/repo`
- **prompt 极薄**：CI log/MR diff 写文件到 cwd，agent 用 read 工具读，不拼进 prompt
- **patch 从 git diff 提取**：agent 自行执行（bash 改文件 + 跑测试），bot 从 `git diff --cached` 取真实 patch，不信任 agent 自述内容
- **钉钉 Stream 边界**：WebSocket 接收只在主进程（长驻）；worker 子进程仅 SDK API 推送（无 WebSocket）
- **session 持久化**：repair 路径用 `SessionManager.create(cwd)` 落盘到保留现场内（`.pi-agent/sessions/`），跨进程 resume 依赖它；`inMemory` 不落盘不可恢复

## Rules

- **G3 diff 白名单（ADR-0004/0006）**：单测失败可改测试/文档与 **MR diff 内**的 `src/main`（有限放宽：铁律是优先满足既有失败测试，严禁改写其断言语义）；static-analysis/Checkstyle 失败可修 **MR diff 内**文件（含 src/main）；禁压制式修复（`@SuppressWarnings`/删规则）；改动绑定报告的 file:line:rule；diff 外一律转交。转交但有部分修复成果 → 开部分修复 MR（描述说明已修/未修/根因，`mrUrl` 随转交通知与决策上下文）。`validatePatchPaths` 在 createMR 前兜底校验
- **绝不自动 merge**：所有 MR 强制人工 review
- **人工决策边界**：`/heal` 决策（test/prod/drop）只消除 agent 诊断不确定性，不授予新权限；**一轮介入**——恢复后再次转交即终局，不产生新决策；决策仅群聊可发，decider 入审计
- **现场保留**：可决策转交（agent 主动 escalated 且带 diagnosis）冻干现场（cwd + worktree + session + branch），注册 awaiting_decision；TTL 默认 24h（`CIHEAL_DECISION_TTL_MS`）到期清扫；新 pipeline 到达（含被排除的）作废同项目待决策并清现场；class 5 转交（bot 早筛或 agent 判定）/bot 故障类转交不保留现场
- **跨 pipeline session 复用（ADR-0007）**：带 MR 成果的终局（mr / 部分修复转交）把 Pi session jsonl 存档到 `DATA_ROOT/mr-sessions/<proj>-<mr>.jsonl`（latest-wins，LRU 上限 32）；同 MR 后续 pipeline 命中则拷入新 worker → `SessionManager.open` + `AgentSession.compact()`（/compact 编程接口）+ continue，prompt 强制声明「MR 已更新到新 commit、不得沿用旧诊断」；存档/复用任何环节失败均降级为全新 session，不阻断修复；审计记 `reusedFromPipeline`
- **stage 排除**：`CIHEAL_SKIP_STAGES`（逗号分隔）中的 stage 全部失败时跳过修复（不起 agent、不注册决策），即时播报保留并尾注「不在自愈范围」；builds 缺失时降级为原行为。修复入队成功的失败播报尾注「已开始修复」，消除失败卡与终局卡之间的静默窗口
- **bot 自身 pipeline 忽略**：源分支为 `ci-self-heal/*` 的 pipeline（bot 修复 MR 触发）回流 webhook 时直接忽略——不播报、不入队、不触发 onNewPipeline（避免 bot 修自己的修复 MR 形成循环、避免作废原 MR 的待决策）；修复 MR 的 CI 监控由 worker 内部轮询驱动（ADR-0004），不受影响
- **钉钉通知与 MR 解耦**：agent 永不持有钉钉工具；bot 代码在确定性 pipeline 节点调钉钉。转交通知一律走 ProjectRouter 到路由群（与失败播报同群）。`CIHEAL_DINGTALK_MODE=fake` 时改为记录不推送
- **预算软上限**：SharedAgentRuntime 在 `turn_end` 累计 token，超 `BOT_BUDGET_TOKENS`（总 200k）或 `BOT_BUDGET_PER_TURN_TOKENS`（单 turn 50k）→ `session.abort()` + 钉钉告警。软上限风险：abort 在 turn 结束后触发，单 turn 可能已超支。resume 预算独立计
- **class 5 早筛**：bot 在 spawn agent 前用关键词筛**依赖错**直接转交，省预算；编译错放行 agent 判 class 2/5（仅测试编译挂 = class 2 可修）——分类是 agent 的职责（与 stage 排除互补：一个按内容、一个按 stage 名）
- **class 3 读 spec**：补缺失测试时断言 spec 规定的正确行为，而非当前代码行为（避免固化 bug）
- **secret 管理**：`GITLAB_WEBHOOK_SECRET` / `GITLAB_TOKEN` / `DINGTALK_CLIENT_ID` / `DINGTALK_CLIENT_SECRET` 走 `.env`（chmod 600 + gitignore），绝不硬编码；`CIHEAL_PI_BASE_DIR` 下的 `auth.json` 不入库不打包
- **模型候选链**：bot 按 `config/model-candidates.json` 顺序选同族首个可用 provider/model；运行中失败直接转人工（不跨族降级、不切换 provider）
- **commit 规范**：conventional commits（feat/fix/refactor/docs/test/chore/perf/ci）

## Agent skills / 项目元信息

- **Issue tracker**：`.scratch/<feature>/`（spec + issues：ci-self-heal-bot / shared-agent-runtime / human-decision-resume）
- **Triage labels**：needs-triage / needs-info / ready-for-agent / ready-for-human / wontfix（见 `docs/agents/triage-labels.md`）
- **Domain docs**：根 `CONTEXT.md`（领域词汇表）+ `docs/adr/`（0001 bot-owned Pi 运行时 / 0002 共享运行时 / 0003 DATA_ROOT 统一 / 0004 G3 放宽+session 复用重试 / 0005 现场保留与决策恢复）
- **Real-run playbook**：`docs/real-run-playbook.md`（真实链路端到端：预检 → 选 pipeline → webhook 投递 → 监控 → 结果解读）
- **Pi 配置指南**：`docs/pi-agent-configuration.md`
