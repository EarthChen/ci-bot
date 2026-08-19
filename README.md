# CI Self-Heal Bot

监听 GitLab pipeline 失败 webhook，用 AI agent（pi SDK）自动诊断根因、修复测试/文档（单测失败绝不碰生产代码；static-analysis/Checkstyle 可修 MR diff 内文件）、开 MR 供人工 review、钉钉推送结果。诊断不确定的转交支持人工在群内 `/heal` 决策，bot 复用原 session 继续修复。

## 特性

- **修复范围（G3 diff 白名单，ADR-0004）**：单测失败只修测试/文档，严禁碰 `src/main`；static-analysis（SpotBugs/PMD）/ Checkstyle 失败可修 MR diff 内文件（含 `src/main`），禁压制式修复；发现范围外的生产代码 bug 自动转交人工
- **人工决策恢复**：agent 诊断不确定（分不清测试错还是源码错）时转交并**冻干现场**（worktree + session + 分支），群内收到带决策 id 的通知；`/heal <id> test|prod|drop [备注]` 后 bot 跨进程恢复原 Pi session 注入决策继续修复；一轮介入，二次转交即终局
- **确定性失败不进修复**：`CIHEAL_SKIP_STAGES=format` 之类的 stage 排除，format 等机械性失败不起 agent、不烧预算，即时播报保留
- **真实工作区**：每个 pipeline 从共享 bare clone 创建 git worktree，agent 在真实代码上迭代
- **共享 Agent Runtime**：`src/agent-runtime` 抽离 Pi session / 模型策略 / 资源加载 / token 预算监控，垂直 agent（如 CI Repair）复用同一运行时
- **预算软上限**：`turn_end` 事件累计 token，超阈值 `session.abort()` + 钉钉告警
- **agent 自行执行**：bash 改文件 + 跑测试，bot 从 `git diff` 提取真实 patch（不信任 agent 自述）
- **极薄 prompt**：CI log/MR diff 写文件到工作区，agent 用 read 工具读，不拼进 prompt
- **钉钉 Stream 双向**：主进程 WebSocket 接收 @bot 群命令（`/route` 动态路由、`/heal` 决策、`/help`）+ SDK API 主动推送；转交/失败通知按项目路由到对应群
- **模型候选链**：bot 按 `config/model-candidates.json` 顺序选择同族首个可用 provider/model，运行中失败直接转人工
- **Pi 配置隔离**：只加载 bot 自带 settings 与 playbook，不加载目标 worktree 的 `.pi` 配置或扩展

## 安装

```bash
pnpm install
cp .env.example .env  # 填入 GitLab + 钉钉 Stream 凭据 + 模型配置
chmod 600 .env
```

依赖：Node ≥ 20、pnpm、glab CLI（GitLab API 调用）。

## 快速开始

```bash
# 1. 启动 webhook 服务（开发模式）
pnpm dev

# 2. 在 GitLab 项目设置里配置 pipeline 失败 webhook 指向
#    http://<host>:<PORT>/webhook/gitlab?repair=1
#    并设置 X-Gitlab-Token = GITLAB_WEBHOOK_SECRET
#    （不带 repair 参数 = 纯失败播报，不触发修复）
#    事件勾选：Pipeline events + Merge request events
#    （后者用于 MR 合并/关闭后清理 bot 侧关联状态，ADR-0008）

# 3. 触发一次单测失败的 pipeline，观察 bot 自动诊断 + 开 MR + 钉钉通知

# 4. 若收到「CI 自愈待人工决策」通知，在群内复制命令回复：
#    /heal D-<pipeline>-<rand> test 按 spec 补断言   # bot 恢复 session 继续修
#    /heal D-<pipeline>-<rand> prod                  # 确认源码 bug，bot 关闭
#    /heal D-<pipeline>-<rand> drop                  # 丢弃
```

生产部署：

```bash
pnpm build
pnpm start
```

容器化部署（Docker Compose，镜像自带 JDK 8 + Maven + glab 完整修复运行时）见 `docs/docker-deployment.md`。

真实链路端到端演练（预检 → 选 pipeline → webhook 投递 → 监控 → 结果解读）见 `docs/real-run-playbook.md`。

## 配置

关键环境变量（`.env`，完整模板见 `.env.example`）：

| 变量 | 说明 |
| --- | --- |
| `GITLAB_WEBHOOK_SECRET` | GitLab webhook 验签 token（X-Gitlab-Token） |
| `GITLAB_TOKEN` | GitLab 项目访问令牌（read_repository + api） |
| `GITLAB_URL` | 自托管 GitLab 地址（gitlab.com 省略） |
| `GITLAB_IP_ALLOWLIST` | GitLab 出口 IP 白名单（空 = 不校验） |
| `DINGTALK_CLIENT_ID` | 钉钉 Stream 模式 AppKey（企业内部应用） |
| `DINGTALK_CLIENT_SECRET` | 钉钉 Stream 模式 AppSecret |
| `DINGTALK_CONVERSATION_ID` | 默认通知群 openConversationId |
| `CIHEAL_BOT_ROOT` | bot 发布根目录的绝对路径；worker 从此加载配置和 playbook，生产环境必填 |
| `CIHEAL_PI_BASE_DIR` | deployment-owned 的绝对目录；每个 worker 从中复制 Pi 原生 `auth.json` / `models.json`，生产环境必填 |
| `CIHEAL_DATA_ROOT` | 全部可写状态的根目录（work/bare/audit/logs + 路由/决策 SQLite） |
| `CIHEAL_SKIP_STAGES` | 逗号分隔的 stage 排除列表（如 `format`）：失败 stage 全部命中时跳过修复 |
| `CIHEAL_DECISION_TTL_MS` | 待决策保留时长（默认 86400000 = 24h），到期清扫 |
| `CIHEAL_DECISION_SWEEP_INTERVAL_MS` | TTL 清扫定时器间隔（默认 60000） |
| `DEEPSEEK_API_KEY` | provider-specific API key，仅由部署环境注入 |
| `BOT_BUDGET_TOKENS` | 单 session 总 token 上限（默认 200000） |
| `BOT_BUDGET_PER_TURN_TOKENS` | 单 turn token 上限（默认 50000） |
| `BOT_WORKER_CRASH_THRESHOLD` | worker 连续崩溃多少次后发自警钉钉（默认 3） |
| `BOT_CONCURRENCY` | 并发数（v1=1） |
| `CIHEAL_AGENT_MODE` / `CIHEAL_GLAB_MODE` / `CIHEAL_DINGTALK_MODE` / `CIHEAL_WORKTREE_MODE` | env-switch DI（`stub | real` / `fake | real`），测试用 fake，生产用 real |

模型相关配置文件（bot-owned，非敏感）：

- `config/model-candidates.json` — 同族 provider/model 有序候选
- `config/model-profiles.json` — 按候选绑定的 Pi settings 子集：`defaultThinkingLevel`、`thinkingBudgets`、`compaction`
- `config/group-routing.json` — 项目 → 群静态路由（动态路由在群内 `/route add <pattern>` 管理，优先级更高）
- `config/command-help.json` — `/heal`、`/route`、`/help` 命令文案

`model-profiles.json` 复用 Pi `settings.json` 字段名，但只允许
`defaultThinkingLevel`、`thinkingBudgets` 与 `compaction`。模型的
`contextWindow`、`maxTokens` 和 reasoning 能力始终以 Pi 内置目录为准。DeepSeek 公共端点**无需 `models.json`**；仅当要自定义 endpoint（如公司网关）时，才在 `CIHEAL_PI_BASE_DIR` 下放 `models.json` 覆盖 `baseUrl`。详见 `docs/pi-agent-configuration.md`。

## 测试

```bash
pnpm test            # 全量
./node_modules/.bin/vitest run tests/e2e/real-agent.test.ts  # 单文件
```

e2e 测试用真实子进程 + stub session（无真实 LLM），通过 sidecar JSON 跨进程观测。人工决策全链路验收在 `tests/e2e/human-decision.test.ts`，stage 排除在 `tests/e2e/stage-exclusion.test.ts`。

## 文档

- 领域词汇表：`CONTEXT.md`
- 设计 spec：`.scratch/ci-self-heal-bot/spec.md`、`.scratch/human-decision-resume/spec.md`
- ADR：`docs/adr/`（0001 bot-owned Pi 运行时 / 0002 共享运行时 / 0003 DATA_ROOT 统一 / 0004 G3 放宽 + session 复用重试 / 0005 现场保留与决策恢复）
- agent skill：`src/agents/ci-repair/resources/skills/ci-self-heal-playbook/`
- Pi 运行时配置指南：`docs/pi-agent-configuration.md`
- 真实链路演练：`docs/real-run-playbook.md`
- Docker 部署手册：`docs/docker-deployment.md`

## 许可证

[待填]
