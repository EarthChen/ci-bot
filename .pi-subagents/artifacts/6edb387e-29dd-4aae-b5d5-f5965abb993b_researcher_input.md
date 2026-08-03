# Task for researcher

研究 OpenAI Codex（codex-cli / codex agent SDK / Responses API + tools 体系）作为 headless CI 自愈 bot 骨架的能力边界，产出研究 brief。

## 背景

用户要建一个 GitLab CI 单测失败自愈 bot，headless、无人值守、多项目并发。SDK 选型开放（候选：Claude Agents SDK / Codex SDK / pi 本身）。本 ticket 只覆盖 Codex SDK 这一候选，与另两份研究合成跨 SDK 对比矩阵。

> 注意："Codex SDK"的确切所指需先厘清——是 codex-cli 的 agent 能力、OpenAI 官方发布的 agent SDK（如 openai-agents python 包）、还是 Responses API + function calling。研究第一步先界定范围，不要把不同东西混在一起。

## 四维度（与另两候选对齐，便于横向比较）

1. **第三方模型支持**：Codex 是否绑定 OpenAI 模型？能接 OpenAI 兼容 API（DeepSeek/Kimi/Qwen）、本地 vLLM/Ollama、Anthropic、Bedrock/Vertex 吗？接法（原生 provider 抽象？model 字符串？自定义 transport？）与限制。

2. **headless 运行形态**：支持无人值守、程序化驱动 loop 吗（非交互 REPL）？subagent/agent 派发与 tool 调用能否无人在环确定性触发？有无 token/turn/工具调用预算的硬上限机制？错误/重试如何处理？

3. **多并发隔离**：同进程内跑多 agent 实例（每项目一 worker）受支持否？有无共享状态陷阱？per-agent context/工具白名单/预算能否独立配置？

4. **可复用领域专长**：Codex 怎么表达可复用领域专长（对应 pi 的 skill / Claude 的 skill）？是 prompt 模板、subagent、tool 包、还是无原生机制？headless 下能否确定性调用（非靠人加载）？特别评估迁移代价：用户在 pi 下积累的 java-coding-standards / springboot-tdd 等 skill 迁移到 Codex 需多少重写。

## 如何验证

- OpenAI 官方文档（Codex / Responses API / Agents 相关 / openai-agents python 包）。
- codex-cli 源码/类型定义（如 GitHub openai/codex 或类似仓库）。
- 社区 headless bot 实例与坑。

## 产出要求

研究 brief（Markdown），写入文件 `/Users/earthchen/ai-work/ci-bot/research/r3-codex-sdk.md`（目录已存在）。结论必须区分：
- **[事实]**：文档/源码明确支持的
- **[未知]**：文档未提、需实测才能确认的
- **[推论]**：基于源码结构/接口的合理推断

末尾给一行对比小结（便于横向比）+ 迁移代价评估。

---
**Output:**
Write your findings to exactly this path: /Users/earthchen/ai-work/ci-bot/.pi-subagents/artifacts/outputs/6edb387e-29dd-4aae-b5d5-f5965abb993b/research.md
This path is authoritative for this run.
Ignore any other output filename or output path mentioned elsewhere, including output destinations in the base agent prompt, system prompt, or task instructions.

## Acceptance Contract
Acceptance level: attested
Completion is not accepted from prose alone. End with a structured acceptance report.

Criteria:
- criterion-1: Return concrete findings with file paths and severity when applicable

Required evidence: review-findings, residual-risks

Finish with a fenced JSON block tagged `acceptance-report` in this shape:
Use empty arrays when no items apply; array fields contain strings unless object entries are shown.
`criteriaSatisfied[].status` must be exactly one of: satisfied, not-satisfied, not-applicable.
`commandsRun[].result` must be exactly one of: passed, failed, not-run.
`manualNotes` and `notes` are optional strings; an empty string means no note and does not satisfy `manual-notes` evidence.
```acceptance-report
{
  "criteriaSatisfied": [
    {
      "id": "criterion-1",
      "status": "satisfied",
      "evidence": "specific proof"
    }
  ],
  "changedFiles": [
    "src/file.ts"
  ],
  "testsAddedOrUpdated": [
    "test/file.test.ts"
  ],
  "commandsRun": [
    {
      "command": "command",
      "result": "passed",
      "summary": "short result"
    }
  ],
  "validationOutput": [
    "validation output or concise summary"
  ],
  "residualRisks": [
    "none"
  ],
  "noStagedFiles": true,
  "diffSummary": "short description of the diff",
  "reviewFindings": [
    "blocker: file.ts:12 - issue found, or no blockers"
  ],
  "manualNotes": "anything else the parent should know"
}
```