# Task for researcher

研究 pi（@earendil-works/pi-coding-agent，即当前 harness）作为 headless CI 自愈 bot 骨架的可行性，产出研究 brief。

## 背景

用户要建一个 GitLab CI 单测失败自愈 bot，headless、无人值守、多项目并发。SDK 选型开放（候选：Claude Agents SDK / Codex SDK / pi 本身）。本 ticket 只覆盖 pi 这一候选。pi 的独特优势：用户已在其下积累完整 skill 体系（java-coding-standards / springboot-tdd / springboot-patterns / python-patterns 等）+ MCP + subagent 机制。核心问题是这些交互式设计的能力在 headless 下是否成立。

## 四维度（与另两候选对齐）

1. **第三方模型支持**：pi 的 provider/model 配置能否接 OpenAI 兼容 API（DeepSeek/Kimi/Qwen）、Anthropic、本地 vLLM/Ollama、Bedrock/Vertex？现有 model 配置机制与限制。

2. **headless 运行形态**：pi 是否支持无人值守、程序化驱动（非 TUI 交互）？能否被 webhook 事件拉起跑一个完整修复 loop 后退出？有无 headless/CLI/SDK 入口（如 `pi -p` / `--print` / SDK 调用）？token/turn/工具预算硬上限？

3. **多并发隔离**：pi 能否同进程/多进程跑多实例（每项目一 worker）？subagent 机制的并发隔离？per-instance context/skill/预算独立配置？

4. **可复用领域专长（最大优势面）**：pi 的 skill 机制在 headless 下能否确定性调用（非人按需加载）？多 skill 选择、context 预算、MCP auth 的 headless 处理？迁移代价最低——用户已有 skill 直接复用，评估这条的可行性分量。

额外：pi 与"本地执行 + .m2 复用"形态的契合度（pi 本就跑在本地，天然访问宿主 FS，沙箱张力如何处理）。

## 如何验证（文档路径已确认存在）

- pi 文档：`/Users/earthchen/.local/share/pnpm/store/v11/links/@earendil-works/pi-coding-agent/0.83.0/e6ab0700319567cdfd4d94d12fb1ba6e1eacc37ce6f950dcbdef173048c3d4e5/node_modules/@earendil-works/pi-coding-agent/README.md` 及其 `docs/`（重点：environment-variables.md、sdk.md、custom-provider.md、models.md、packages.md、extensions.md、skills.md）。
- `examples/`（extensions/custom tools/SDK 集成实例）。
- 实测 pi 的 headless/CLI 运行入口（如 `pi -p` / `--print` / SDK 调用 / `pi run` 等）。

## 产出要求

研究 brief（Markdown），写入文件 `/Users/earthchen/ai-work/ci-bot/research/r4-pi-as-bot.md`（目录已存在）。结论必须区分：
- **[事实]**：文档/源码明确支持的
- **[未知]**：文档未提、需实测才能确认的
- **[推论]**：基于源码结构/接口的合理推断

末尾给一行对比小结 + 迁移代价评估（pi 这条预期最低，需证实）。

---
**Output:**
Write your findings to exactly this path: /Users/earthchen/ai-work/ci-bot/.pi-subagents/artifacts/outputs/cf1be6b5-1967-4533-988d-f836e3181d75/research.md
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