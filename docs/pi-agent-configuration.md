# Pi Agent Configuration

本文描述 CI 自愈 bot 当前如何创建、隔离与约束 Pi agent。它是运行时行为说明，不取代 [`CONTEXT.md`](../CONTEXT.md) 的术语定义和 [ADR-0001](adr/0001-bot-owned-pi-runtime.md) 的架构决策。

## 1. 目标与边界

bot 使用 Pi agent 诊断失败的单元测试，并仅允许其处理测试或相关文档。Pi 配置必须由 bot 发布包控制，而不能由被修复项目、目标分支或宿主机用户目录控制。

明确不支持：

- 从目标 worktree 加载 `.pi/**`、`.agents/skills/**`、`SYSTEM.md`、扩展、主题或 context 文件；
- 依据目标项目配置切换 provider、模型、thinking 或工具集；
- 在 session 已开始后切换 provider/model 或重放工具操作；
- 用 bot 配置覆盖 Pi model catalog 中的 `contextWindow`、`maxTokens` 或 reasoning 能力。

## 2. 配置所有权与文件布局

部署必须设置绝对路径 `CIHEAL_BOT_ROOT`。它指向完整的 bot 发布目录，至少应包含：

```text
$CIHEAL_BOT_ROOT/
├── .pi/
│   ├── settings.json
│   └── APPEND_SYSTEM.md
├── .agents/skills/
│   └── ci-self-heal-playbook/
└── config/
    ├── model-candidates.json
    └── model-profiles.json
```

`RealAgentRunner` 会验证 `CIHEAL_BOT_ROOT/config` 和 bundled playbook 存在；缺失时 session 初始化失败并升级人工，而不是从目标 worktree 或用户全局目录寻找替代配置。

部署还必须设置绝对路径 `CIHEAL_PI_BASE_DIR`。这是 deployment-owned 的只读目录，包含 Pi 原生格式的 `auth.json`、`models.json` 或两者。`auth.json` 必须由 Secret Manager/secret volume 提供，绝不能打入 release 或提交到 git。

每个 pipeline worker 另有独立的 `PI_CODING_AGENT_DIR`：

```text
<worker 临时目录>/.pi-agent
```

启动 worker 前，`SubprocessWorkerManager` 将 `CIHEAL_PI_BASE_DIR` 中存在的 `auth.json` 和 `models.json` 拷贝到该目录，并将副本权限收紧为 owner-only。基础目录保持不变，worker 之间不会共享可写的 Pi runtime 状态。Pi `ModelRuntime` 只从这个 worker-private 目录读取文件。它位于目标仓库 worktree 之外，因此目标分支无法通过提交 `.pi-agent` 注入模型认证或模型定义。

## 3. 启动与选择流程

```mermaid
sequenceDiagram
    participant W as Worker subprocess
    participant R as RealAgentRunner
    participant M as Pi ModelRuntime
    participant S as Pi SettingsManager
    participant A as Pi AgentSession

    W->>R: 启动，传入独立 PI_CODING_AGENT_DIR
    W->>W: 从 CIHEAL_PI_BASE_DIR 拷贝 auth.json / models.json
    R->>R: 验证 CIHEAL_BOT_ROOT
    R->>M: 读取 worker-private auth.json / models.json
    R->>R: 读取 candidates 与 profiles
    R->>M: 按顺序验证候选模型可用性
    R->>S: 应用选中 profile
    R->>A: 显式传入 model、thinkingLevel 与受限资源
    A-->>R: 单一连续 session
```

候选选择只发生在 session 创建前：

1. 依序读取 `config/model-candidates.json`；
2. 查找候选的具体 `provider/model`；
3. 若配置的 `keyEnv` 存在，使用 `setRuntimeApiKey()` 将 key 仅注入内存；
4. 调用 Pi runtime 的可用模型查询；
5. 选择第一个可用候选及其 profile；
6. 失败的临时 key 会调用 `removeRuntimeApiKey()` 清理；所有候选失败则升级人工。

运行中的 provider、认证或 session 异常不会触发候选切换；bot 返回 `escalated`，由人工处理。

## 4. 模型候选与 profile

### 4.1 `config/model-candidates.json`

候选是非敏感、bot-owned 的有序数组。当前配置为同一 DeepSeek provider 内的备用链：

```json
[
  {
    "provider": "deepseek",
    "model": "deepseek-chat",
    "keyEnv": "DEEPSEEK_API_KEY",
    "profile": "deepseek-chat"
  },
  {
    "provider": "deepseek",
    "model": "deepseek-reasoner",
    "keyEnv": "DEEPSEEK_API_KEY",
    "profile": "deepseek-reasoner"
  }
]
```

这实现了「主模型 → 同族备用 → 人工介入」策略，禁止 DeepSeek 到 OpenAI 等跨族自动降级。`keyEnv` 的值仅由部署 Secret Manager 或运行环境注入，绝不能写入该 JSON 文件或仓库。

为了与旧部署兼容，若候选 provider 与 `MODEL_PROVIDER` 相同，选择器可使用 `MODEL_API_KEY`；新部署应优先使用候选所声明的 provider-specific key。

### 4.2 `config/model-profiles.json`

profile 使用 Pi `settings.json` 的原生字段名，但 schema 被刻意限制为下列可变策略：

| 字段 | 作用 |
| --- | --- |
| `defaultThinkingLevel` | 传给 `createAgentSession` 的默认 thinking level |
| `thinkingBudgets` | 为各 thinking level 定义 token budget |
| `compaction.enabled` | 是否启用 Pi 上下文压缩 |
| `compaction.reserveTokens` | 为未来上下文预留的 token 数 |
| `compaction.keepRecentTokens` | 压缩时保留的最近 token 数 |

当前 policy：

| profile | thinking | thinking budget | reserve / keep recent |
| --- | --- | ---: | ---: |
| `deepseek-chat` | `medium` | 16,384 | 16,384 / 20,000 |
| `deepseek-reasoner` | `high` | 32,768 | 32,768 / 24,000 |

loader 会拒绝未知 profile 字段、无效 thinking level、非正数 budget，以及不合法 compaction 配置。候选所引用的 profile 不存在也会让 session 初始化失败。

模型 catalog 属性不在 profile 中声明：Pi `ModelRuntime` 提供模型的上下文窗口、最大输出 token 与 reasoning 能力，避免 bot 配置和 provider catalog 分叉。

## 5. Pi Settings、System Prompt 与 resources

bot 基础 `.pi/settings.json` 当前只控制跨模型的通用行为：

```json
{
  "retry": { "enabled": true, "maxRetries": 2 },
  "enableSkillCommands": true
}
```

选中模型后，profile 会通过 `SettingsManager.applyOverrides()` 覆盖 thinking 与 compaction 策略。

为保留 Pi 内建的工具说明和通用 system prompt，bot **不会**创建 `.pi/SYSTEM.md` 来替换默认 prompt。它改用 `.pi/APPEND_SYSTEM.md` 追加以下规则：

- bundled `ci-self-heal-playbook` 是唯一权威诊断流程；
- 仅修改测试或相关文档，绝不修改生产源码；
- 输出 bot 可验证的结构化结果。

`DefaultResourceLoader` 使用以下白名单式配置：

| 项目 | 行为 |
| --- | --- |
| skill | 禁用自动发现；显式加入 `$CIHEAL_BOT_ROOT/.agents/skills/ci-self-heal-playbook` |
| extensions | 禁用 |
| prompt templates | 禁用 |
| themes | 禁用 |
| context files | 禁用 |
| target worktree `SYSTEM.md` | 不加载 |
| append prompt | 仅追加 `$CIHEAL_BOT_ROOT/.pi/APPEND_SYSTEM.md` |

因此，目标仓库的 Pi 文件不能改变 agent 的系统指令、技能、扩展或运行配置。

## 6. Session、工具与持久化

bot 对每个 pipeline 创建一个连续 Pi session，用于诊断、修复建议和可选文档同步。session 配置如下：

- 显式 `model`：启动阶段选中的具体 Pi model；
- 显式 `thinkingLevel`：选中 profile 的 `defaultThinkingLevel`；
- `SessionManager.inMemory(...)`：不保存 Pi session 历史；
- tools：`read`、`grep`、`find`、`ls`、`bash`；
- 不提供 Pi `edit` 或 `write` tool。

CI log 与 MR diff 会先写入 worker 临时目录，agent 通过 `read` 读取，避免把大文本内联进 prompt。变更的权威来源仍是 bot 从 worktree `git diff` 提取的 patch，而不是 agent 的自述。

## 7. Token 预算与结果安全

bot 的 session 预算由环境变量控制：

| 变量 | 默认值 | 含义 |
| --- | ---: | --- |
| `BOT_BUDGET_TOKENS` | 200,000 | session 累计 token 上限 |
| `BOT_BUDGET_PER_TURN_TOKENS` | 50,000 | 单个 turn token 上限 |

`turn_end` 事件累计 usage。若单 turn 或累计用量超过上限，bot 调用 `session.abort()`，结束后发送 best-effort 钉钉告警，并将结果升级人工。该机制是软上限：abort 发生在 turn 结束后，因此单个 turn 可能已超过阈值。

模型初始化与运行错误写入服务日志，但对外的 MR/钉钉结果使用固定、脱敏的说明，避免 provider 响应、认证错误或 token 出现在外部通知中。

## 8. 部署与变更检查清单

部署至少应提供：

```env
CIHEAL_BOT_ROOT=/opt/ci-self-heal-bot
CIHEAL_PI_BASE_DIR=/run/secrets/ci-self-heal-pi
DEEPSEEK_API_KEY=... # 通过 Secret Manager 或部署环境注入
```

变更 Pi 配置时：

1. 只修改 bot 发布目录中的 `.pi/`、`config/` 或 bundled skill；
2. `CIHEAL_PI_BASE_DIR` 只能来自部署受控的绝对路径，且至少有 `auth.json` 或 `models.json`；
3. provider/model 变更必须保持同族备用策略；
4. profile 只能使用第 4.2 节列出的 Pi Settings 字段；
5. 不要把 API key、auth 文件或 provider 响应提交到仓库；
6. 执行 `pnpm test` 与 `pnpm typecheck`；若 `pnpm` 的 build approval 阻塞测试，可按项目约定使用 `./node_modules/.bin/vitest run` 与 `./node_modules/.bin/tsc -p tsconfig.json --noEmit`。
