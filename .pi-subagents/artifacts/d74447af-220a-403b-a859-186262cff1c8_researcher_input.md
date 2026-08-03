# Task for researcher

研究 Claude Agents SDK 中 skill 与 MCP 在 headless、无人值守、多项目并发场景下的消费方式，产出研究 brief。

## 背景

用户已断言"Claude Code Agents SDK 支持 skill、MCP 等能力"——这在交互式形态下成立。本研究聚焦 **headless、无人值守、多项目并发** 下能否消费这些能力、以及怎么消费。

## 研究范围（四点）

1. **skill 在 SDK 里的形态**：SDK 暴露给自建程序的"skill"接口长什么样？是 Claude Code 交互式的同款机制、还是 SDK 自有原语（如可配置 system prompt + tool 集）？能否被 headless 程序**确定性**调用（非靠人在 REPL 里加载）？调用 API 形式是什么。

2. **多 skill 选择机制**：无人值守时怎么选哪个 skill 处理哪类失败？是显式路由规则（bot 代码决定）、还是让 agent 自主选（LLM 决定）？各自的风险（误选/不选/context 爆炸）。

3. **context 预算**：skill 是"把 markdown 灌进 context"——多 skill 叠加 / 大 skill 文本会不会撑爆 token 预算？SDK 有无压缩/检索（RAG/摘要/context window 管理）原语？

4. **MCP 工具的 headless 适配**：MCP 工具可能需交互式 auth、有 rate limit、有状态——headless 批跑下怎么确定性处理（预置 token、自动续期、失败重试策略）？SDK 的 MCP client 是否支持非交互式 auth flow？

## 如何验证

- 官方文档关于 Agent Skills、MCP、tool authorization、headless 模式的章节。
- SDK 类型定义中 skill/MCP 相关接口。
- 已有用 SDK 自建 headless bot 的实例（含失败案例）。

## 产出要求

研究 brief（Markdown），写入文件 `/Users/earthchen/ai-work/ci-bot/research/r2-skill-mcp-headless.md`（目录不存在则创建）。结论必须区分：
- **[事实]**：SDK 文档/源码明确支持的
- **[未知]**：文档未提、需实测才能确认的
- **[推论]**：基于源码结构/接口的合理推断

特别标注：若 SDK 的"skill"与交互式 Claude Code 不同款，明确给出 SDK 里**可复用领域专长**的对应物是什么（system prompt 模板？subagent？MCP tool 包？），供后续设计据以重新定调。

---
**Output:**
Write your findings to exactly this path: /Users/earthchen/ai-work/ci-bot/.pi-subagents/artifacts/outputs/d74447af-220a-403b-a859-186262cff1c8/research.md
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