# CI Self-Heal Bot

监听 GitLab pipeline 单测失败 webhook，用 AI agent（pi SDK）自动诊断根因、修复测试（绝不碰生产代码）、开 MR 供人工 review、钉钉推送结果。

## 特性

- **只修测试/文档**：G3 权限边界，`src/main` 禁碰；发现生产代码 bug 自动转交人工
- **真实工作区**：每个 pipeline 从共享 bare clone 创建 git worktree，agent 在真实代码上迭代
- **预算软上限**：`turn_end` 事件累计 token，超阈值 `session.abort()` + 钉钉告警
- **agent 自行执行**：bash 改文件 + 跑测试，bot 从 `git diff` 提取真实 patch（不信任 agent 自述）
- **极薄 prompt**：CI log/MR diff 写文件到工作区，agent 用 read 工具读，不拼进 prompt
- **钉钉解耦**：agent 永不持有钉钉工具，bot 在确定性节点调钉钉
- **模型候选链**：bot 按 `config/model-candidates.json` 顺序选择同族的首个可用 provider/model，运行中失败直接转人工
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
#    http://<host>:<PORT>/webhook
#    并设置 X-Gitlab-Token = GITLAB_WEBHOOK_SECRET

# 3. 触发一次单测失败的 pipeline，观察 bot 自动诊断 + 开 MR + 钉钉通知
```

生产部署：

```bash
pnpm build
pnpm start
```

## 配置

关键环境变量（`.env`，完整模板见 `.env.example`）：

| 变量 | 说明 |
| --- | --- |
| `GITLAB_WEBHOOK_SECRET` | GitLab webhook 验签 token（X-Gitlab-Token） |
| `GITLAB_TOKEN` | GitLab 项目访问令牌（read_repository + api） |
| `GITLAB_URL` | 自托管 GitLab 地址（gitlab.com 省略） |
| `DINGTALK_CLIENT_ID` | 钉钉 Stream 模式 AppKey（企业内部应用） |
| `DINGTALK_CLIENT_SECRET` | 钉钉 Stream 模式 AppSecret |
| `DINGTALK_CONVERSATION_ID` | 默认通知群 openConversationId |
| `config/model-candidates.json` | bot-owned 的同族 provider/model 有序候选（非敏感） |
| `config/model-profiles.json` | 按候选绑定的 Pi settings 子集：`defaultThinkingLevel`、`thinkingBudgets`、`compaction` |
| `CIHEAL_BOT_ROOT` | bot 发布根目录的绝对路径；worker 从此加载配置和 playbook，生产环境必填 |
| `CIHEAL_PI_BASE_DIR` | deployment-owned 的绝对目录；每个 worker 从中复制 Pi 原生 `auth.json` / `models.json`，生产环境必填 |
| `DEEPSEEK_API_KEY` | provider-specific API key，仅由部署环境注入 |
| `MODEL_PROVIDER` / `MODEL_API_KEY` | 旧版单 provider 兼容配置，可选 |
| `BOT_BUDGET_TOKENS` | 单 session 总 token 上限（默认 200000） |
| `BOT_BUDGET_PER_TURN_TOKENS` | 单 turn token 上限（默认 50000） |
| `BOT_CONCURRENCY` | 并发数（v1=1） |

`model-profiles.json` 复用 Pi `settings.json` 字段名，但只允许
`defaultThinkingLevel`、`thinkingBudgets` 与 `compaction`。模型的
`contextWindow`、`maxTokens` 和 reasoning 能力始终以 Pi 的 model catalog 为准，
不在 bot 配置中重复声明。

## 测试

```bash
pnpm test            # 全量
./node_modules/.bin/vitest run tests/e2e/real-agent.test.ts  # 单文件
```

e2e 测试用真实子进程 + stub session（无真实 LLM），通过 sidecar JSON 跨进程观测。

## 文档

- 设计 spec：`.scratch/ci-self-heal-bot/spec.md`
- 8 个 issue ticket：`.scratch/ci-self-heal-bot/issues/`
- agent skill：`.agents/skills/ci-self-heal-playbook/`
- 决策地图：`wayfinder/MAP.md`

## 许可证

[待填]
