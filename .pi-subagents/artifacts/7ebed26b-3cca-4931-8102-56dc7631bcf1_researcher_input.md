# Task for researcher

研究 Claude Agents SDK（Anthropic 官方 Claude Code/Agents SDK）的能力边界，产出一份研究 brief。

## 研究范围（三点）

1. **第三方模型协议支持**：SDK 能否接 OpenAI 兼容 API（DeepSeek/Kimi/Qwen）、Anthropic 路由网关、本地 vLLM/Ollama、云托管（AWS Bedrock/GCP Vertex）？接法是 SDK 原生 provider 适配、还是要求 model 字符串配置、还是要自定义 transport？具体 API/配置形式是什么。

2. **headless 运行形态**：SDK 是否支持无人值守、可程序化驱动的 loop（非交互式 REPL）？subagent 派发与 tool 调用能否在无人在环时确定性触发？有无 token/turn/工具调用预算的硬上限机制？错误/重试如何处理？

3. **多并发隔离**：同一进程内跑多个 SDK agent 实例（每项目一个 worker）是否受支持、有无共享状态陷阱、per-agent context/工具白名单/预算能否独立配置？

## 如何验证

- 官方文档（Anthropic Claude Agents SDK / Claude Code SDK）关于 custom provider、third-party model、headless mode、subagent、tool/turn budget 的章节。
- SDK 源码/类型定义（npm 包 @anthropic-ai/claude-code-sdk 或 claude-agent-sdk 等）的 provider 接口与 transport 抽象。
- 社区/issue 中第三方模型接入实例与坑。

## 产出要求

研究 brief（Markdown），写入文件 `/Users/earthchen/ai-work/ci-bot/research/r1-sdk-capabilities.md`（目录不存在则创建）。结论必须区分：
- **[事实]**：SDK 文档/源码明确支持的
- **[未知]**：文档未提、需实测才能确认的
- **[推论]**：基于源码结构/接口的合理推断

特别关注：如果 SDK 的"第三方模型支持"有版本差异或限制（如只在某 SDK 分支、需特定 license），明确标注。

---
**Output:**
Write your findings to exactly this path: /Users/earthchen/ai-work/ci-bot/.pi-subagents/artifacts/outputs/7ebed26b-3cca-4931-8102-56dc7631bcf1/research.md
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