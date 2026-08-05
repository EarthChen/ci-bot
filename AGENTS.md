# CI Self-Heal Bot

## Project

CI 单测自愈 bot：headless 长驻 TS 服务，监听 GitLab pipeline 失败 webhook → 共享 Pi Agent Runtime 驱动 agent 诊断单测失败根因 → 只修测试/文档（绝不碰生产代码 `src/main`）→ 开 MR 供人工 review → 钉钉推送结果。v1 仅处理单测失败。

> [推断] "CI 单测自愈" 是当前唯一 vertical agent；架构已抽离出共享 Agent Runtime（`src/agent-runtime`），后续 vertical agent 复用同一运行时。

## Stack

- **语言/运行时**：TypeScript（ES2022, NodeNext），Node ≥ 20
- **SDK**：`@earendil-works/pi-coding-agent` 0.83.0（agent 能力 + skill 加载 + session 管理）
- **Web 框架**：Fastify 5（webhook 接收）
- **日志**：pino 9（结构化 JSON）
- **钉钉**：`dingtalk-stream` SDK（Stream 模式：主进程 WebSocket 接收 + SDK API 推送）
- **测试**：vitest 2（forks singleFork，子进程测试隔离）
- **构建**：tsc 直出 `dist/`（无 bundler）
- **包管理**：pnpm（lockfile 提交；`onlyBuiltDependencies` 已声明）

## Commands

```bash
pnpm install          # 安装依赖（非交互用 ./node_modules/.bin/tsc|vitest 绕过 onlyBuiltDependencies 审批）
pnpm build            # tsc -p tsconfig.json → dist/
pnpm typecheck        # tsc --noEmit（CI 门禁）
pnpm test             # vitest run（全量）
pnpm test:watch       # vitest watch
pnpm dev              # tsx src/main.ts（开发模式）
pnpm start            # node dist/main.js（生产）
pnpm audit           # pnpm audit --prod
pnpm metrics          # node scripts/metrics-summary.mjs
```

## Architecture

```text
src/
  main.ts                  # 入口：config + Fastify + StreamDingTalkBot/Notifier + scheduler + worker manager
  config/index.ts          # .env 解析 + 配置校验；必填 CIHEAL_BOT_ROOT / CIHEAL_PI_BASE_DIR（绝对路径）缺失即抛
  webhook/receiver.ts      # POST /webhook：IP allowlist → 限流 → X-Gitlab-Token 验签 → 项目ID路径穿越校验 → 去重 → 入队
  queue/scheduler.ts       # FIFO 队列 + 并发上限（默认 1）+ per-project 串行 + pipeline-id 幂等去重 + worker 崩溃自警
  worker/
    manager.ts             # SubprocessWorkerManager：per-event spawn 子进程，cwd/env 隔离；从 CIHEAL_PI_BASE_DIR 复制 Pi auth/models 到 .pi-agent
    entry.ts               # 子进程入口：env-switch DI（agent/glab/dingtalk/verify 模式）+ runRepair
    main.ts                # 子进程 bootstrap（import entry.main + exit）
  pipeline/
    run-repair.ts          # G2 编排：fetch CI log → class-5 早筛 → agent run → extractPatch → G3 校验 → verifyTestsGreen → createMR → 钉钉
    worktree.ts            # 共享 bare clone + per-pipeline git worktree（agent 真实工作区）
  agent-runtime/
    runtime.ts             # SharedAgentRuntime：创建 Pi session、模型策略、资源加载、token 预算监控、执行循环（垂直 agent 共享）
  agent/
    ci-repair-definition.ts  # CI Repair 垂直 agent 的 AgentDefinition（buildPrompt + resources 引用）
    real-runner.ts         # RealAgentRunner：委托 SharedAgentRuntime，负责 CI 侧结构化结果解析 + 升级 + 预算钉钉告警
    model-selection.ts     # bot-owned 同族 provider/model 候选链（config/model-candidates.json + model-profiles.json）
    runner.ts / stub-session.ts  # AgentRunner 接口 + StubAgentRunner + e2e stub session
  agents/ci-repair/        # CI Repair 垂直 agent 资源：resources/APPEND_SYSTEM.md、resources/skills/ci-self-heal-playbook/、result-parser.ts
  gitlab/glab-client.ts    # glab CLI 包装：fetchCiLog / fetchMrDiff / createMr
  notify/
    dingtalk.ts            # DingTalkNotifier 接口 + InMemory（测试）
    stream-dingtalk.ts     # StreamDingTalkNotifier：SDK API 推送（groupMessages/send）
    stream-bot.ts          # DingTalkStreamBot：主进程 WebSocket 接收 TOPIC_ROBOT
  types.ts / util/log.ts   # 领域类型 + pino logger
config/                    # model-candidates.json + model-profiles.json（bot-owned，非敏感）
.pi/                       # bot 基础 settings.json（retry / skill-commands 全局策略）
tests/                     # agent-runtime / agent / config / e2e / worker / notify / webhook / fixture
```

> CI：`[缺]` 无 `.github/workflows`（仅 `.github/modernize` 工具目录）。Git remote：`[缺]` 未配置。

## Conventions

- **ESM**：`type: module`，import 必须带 `.js` 扩展（NodeNext 解析）
- **缩进**：tab
- **DI via env-switch**：`CIHEAL_AGENT_MODE=stub|real`、`CIHEAL_GLAB_MODE=fake|real`、`CIHEAL_DINGTALK_MODE=fake|real`、`CIHEAL_SESSION_FACTORY=stub`、`CIHEAL_STUB_CI_LOG`、`CIHEAL_STUB_VERIFY` —— 测试用 fake/stub，生产用 real
- **跨进程观测**：fake glab/dingtalk 把调用记到 cwd 下 sidecar JSON（`glab-mr-creates.json` / `dingtalk-sent.json` / `verify-calls.json`），父测试读回
- **worker 隔离**：per-event 临时 cwd + 独立 `PI_CODING_AGENT_DIR`（=`.pi-agent`）+ 独立 env；worktree 在 `<cwd>/repo`，临时文件（ci-log.txt/mr-diff.patch）在 cwd 根（worktree 外）
- **prompt 极薄**：CI log/MR diff 写文件到 cwd，agent 用 read 工具读，不拼进 prompt
- **patch 从 git diff 提取**：agent 自行执行（bash 改文件 + 跑测试），bot 从 `git diff --cached` 取真实 patch，不信任 agent 自述内容
- **钉钉 Stream 边界**：WebSocket 接收只在主进程（长驻）；worker 子进程仅 SDK API 推送（无 WebSocket）

## Rules

- **G3 权限边界**：bot 只写测试/文档，`src/main` 禁碰。发现生产代码 bug → 转交人工。`validatePatchPaths` 在 createMR 前校验，违规即升级不建 MR
- **绝不自动 merge**：所有 MR 强制人工 review
- **钉钉通知与 MR 解耦**：agent 永不持有钉钉工具；bot 代码在确定性 pipeline 节点（成功/转交/异常/崩溃自警）调钉钉
- **预算软上限**：SharedAgentRuntime 在 `turn_end` 累计 token，超 `BOT_BUDGET_TOKENS`（总 200k）或 `BOT_BUDGET_PER_TURN_TOKENS`（单 turn 50k）→ `session.abort()` + 钉钉告警。软上限风险：abort 在 turn 结束后触发，单 turn 可能已超支
- **class 5 早筛**：bot 在 spawn agent 前用关键词粗筛编译/依赖错，省预算
- **class 3 读 spec**：补缺失测试时断言 spec 规定的正确行为，而非当前代码行为（避免固化 bug）
- **secret 管理**：`GITLAB_WEBHOOK_SECRET` / `GITLAB_TOKEN` / `DINGTALK_CLIENT_ID` / `DINGTALK_CLIENT_SECRET` 走 `.env`（chmod 600 + gitignore），绝不硬编码；`CIHEAL_PI_BASE_DIR` 下的 `auth.json` 不入库不打包
- **模型候选链**：bot 按 `config/model-candidates.json` 顺序选同族首个可用 provider/model；运行中失败直接转人工（不跨族降级、不切换 provider）
- **commit 规范**：conventional commits（feat/fix/refactor/docs/test/chore/perf/ci）

## Agent skills / 项目元信息

- **Issue tracker**：`.scratch/<feature>/`（spec + issues，如 `.scratch/shared-agent-runtime/`）
- **Triage labels**：needs-triage / needs-info / ready-for-agent / ready-for-human / wontfix（见 `docs/agents/triage-labels.md`）
- **Domain docs**：根 `CONTEXT.md` + `docs/adr/`（见 `docs/agents/domain.md`）
- **Shared runtime ADR**：`docs/adr/0002-shared-runtime-static-vertical-agents.md`
