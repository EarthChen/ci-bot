# CI Self-Heal Bot

## Project

CI 单测自愈 bot：headless 长驻 TS 服务，监听 GitLab pipeline 失败 webhook → pi SDK agent 自动诊断单测失败根因 → 只修测试/文档（绝不碰 `src/main`）→ 开 MR 供人工 review → 钉钉推送结果。v1 仅处理单测失败，按窄→宽迭代。

## Stack

- **语言/运行时**：TypeScript（ES2022, NodeNext 模块），Node ≥ 20
- **SDK**：`@earendil-works/pi-coding-agent` 0.83.0（agent 能力 + skill 加载 + session 管理）
- **Web 框架**：Fastify 5（webhook 接收）
- **日志**：pino 9（结构化 JSON）
- **测试**：vitest 2（forks singleFork，子进程测试隔离）
- **构建**：tsc 直出 `dist/`（无 bundler）
- **包管理**：pnpm（lockfile 提交）

## Commands

```bash
pnpm install          # 安装依赖
pnpm build            # tsc -p tsconfig.json → dist/
pnpm typecheck        # tsc --noEmit（CI 门禁）
pnpm test             # vitest run（全量）
pnpm test:watch       # vitest watch
pnpm dev              # tsx src/main.ts（开发模式）
pnpm start            # node dist/main.js（生产）
```

> pnpm install 会触发 `onlyBuiltDependencies` 审批（@google/genai、protobufjs、esbuild）；非交互场景用 `./node_modules/.bin/tsc` / `./node_modules/.bin/vitest` 绕过。

## Architecture

```text
src/
  main.ts              # 入口：config + Fastify + scheduler + worker manager
  config/index.ts      # .env 解析 + 配置校验（必填项缺失即抛）
  webhook/receiver.ts  # POST /webhook：IP allowlist → 限流 → X-Gitlab-Token 验签 → 去重 → 入队
  queue/scheduler.ts   # FIFO 队列 + 并发上限（v1=1）+ per-project 串行 + pipeline-id 幂等去重
  worker/
    manager.ts         # SubprocessWorkerManager：per-event spawn 子进程，cwd/env 隔离
    entry.ts           # 子进程入口：env-switch DI（agent/glab/dingtalk 模式）+ runRepair
    main.ts            # 子进程 bootstrap（import entry.main + exit）
  pipeline/
    run-repair.ts      # G2 编排：fetch CI log → 创建 worktree → agent run → extractPatch → G3 校验 → verifyTestsGreen → createMR → 钉钉
    worktree.ts        # 共享 bare clone + per-pipeline git worktree（agent 真实工作区）
  agent/
    real-runner.ts     # RealAgentRunner：pi SDK createAgentSession + 预算软上限（turn_end + abort）+ 结构化结果解析
    runner.ts          # AgentRunner 接口 + StubAgentRunner（ticket 01 stub）
    stub-session.ts    # e2e stub session（DI 注入，无真实 LLM）
  gitlab/glab-client.ts  # glab CLI 包装：fetchCiLog / fetchMrDiff / createMr
  notify/dingtalk.ts  # DingTalkNotifier（InMemory 测试 + HTTP 生产）
  types.ts            # PipelineEvent / Diagnosis / AgentResult / Patch / RepairOutcome
  util/log.ts         # pino logger
tests/
  e2e/                # tracer-bullet.test.ts + real-agent.test.ts（真实子进程 + sidecar 观测）
  config/             # parse-env.test.ts
.agents/skills/ci-self-heal-playbook/  # agent 用的诊断/修复/文档同步 skill（SKILL.md + references/）
```

## Conventions

- **ESM**：`type: module`，import 必须带 `.js` 扩展（NodeNext 解析）
- **缩进**：tab
- **DI via env-switch**：`CIHEAL_AGENT_MODE=stub|real`、`CIHEAL_GLAB_MODE=fake|real`、`CIHEAL_DINGTALK_MODE=fake|real`、`CIHEAL_WORKTREE_MODE=fake|real`、`CIHEAL_SESSION_FACTORY=stub` —— 测试用 fake/stub，生产用 real
- **跨进程观测**：fake glab/dingtalk 把调用记到 cwd 下 sidecar JSON（`glab-mr-creates.json` / `dingtalk-sent.json`），父测试读回
- **worker 隔离**：per-event 临时 cwd + 独立 `PI_CODING_AGENT_DIR` + 独立 env；worktree 在 `<cwd>/repo`，临时文件（ci-log.txt/mr-diff.patch）在 cwd 根（worktree 外）
- **prompt 极薄**：CI log/MR diff 写文件到 cwd，agent 用 read 工具读，不拼进 prompt
- **patch 从 git diff 提取**：agent 自行执行（bash 改文件 + 跑测试），bot 从 `git diff --cached` 取真实 patch，不信任 agent 自述内容

## Rules

- **G3 权限边界**：bot 只写测试/文档，`src/main` 禁碰。发现生产代码 bug → 转交人工。`validatePatchPaths` 在 createMR 前校验，违规即升级不建 MR
- **绝不自动 merge**：所有 MR 强制人工 review
- **钉钉通知与 MR 解耦**：agent 永不持有钉钉工具；bot 代码在确定性 pipeline 节点（成功/转交/异常）调钉钉
- **预算软上限**：`turn_end` 事件累计 token，超 `BOT_BUDGET_TOKENS`（总）或 `BOT_BUDGET_PER_TURN_TOKENS`（单 turn）→ `session.abort()` + 钉钉告警。软上限风险：abort 在 turn 结束后触发，单 turn 可能已超支
- **class 5 早筛**：bot 代码在 spawn agent 前用关键词粗筛编译/依赖错，省预算
- **class 3 读 spec**：补缺失测试时断言 spec 规定的正确行为，而非当前代码行为（避免固化 bug）
- **secret 管理**：`GITLAB_WEBHOOK_SECRET` / `GITLAB_TOKEN` / `DINGTALK_WEBHOOK_URL` 走 `.env`（chmod 600 + gitignore），绝不硬编码
- **commit 规范**：conventional commits（feat/fix/refactor/docs/test/chore/perf/ci）

## Agent skills

### Issue tracker

Local markdown — issues and specs live as files under `.scratch/<feature>/` (see `docs/agents/issue-tracker.md`). The existing `wayfinder/` directory holds the design-effort map and decision tickets for this repo.

### Triage labels

Default five canonical labels (`needs-triage` / `needs-info` / `ready-for-agent` / `ready-for-human` / `wontfix`). See `docs/agents/triage-labels.md`.

### Domain docs

Single-context — one `CONTEXT.md` + `docs/adr/` at the repo root (lazily created by `/domain-modeling`). See `docs/agents/domain.md`.
