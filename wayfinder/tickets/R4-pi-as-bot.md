# R4: pi 作为 headless bot 骨架的可行性研究

> **wayfinder:research** · 状态: open · 类型: AFK（researcher subagent）· assignee: unclaimed
>
> **Blocked by**: —（与 R1/R2/R3 并行，各覆盖一个候选 SDK）

## Question

研究 `@earendil-works/pi-coding-agent`（pi，即本 harness）作为 headless CI 自愈 bot 骨架的可行性。与 R1（Claude SDK）、R3（Codex）合成跨 SDK 对比矩阵供 G6 选型。

pi 的独特优势：用户已在其下积累完整 skill 体系（java-coding-standards / springboot-tdd / springboot-patterns / python-patterns 等）+ MCP + subagent 机制。本研究的核心问题是这些**交互式设计的能力在 headless 下是否成立**。

四维度（与 R1/R3 对齐）：
1. **第三方模型支持**：pi 的 provider/model 配置能否接 OpenAI 兼容 API（DeepSeek/Kimi/Qwen）、Anthropic、本地、Bedrock/Vertex？现有 model 配置机制与限制。
2. **headless 运行形态**：pi 是否支持无人值守、程序化驱动（非 TUI 交互）？能否被 webhook 事件拉起跑一个完整修复 loop 后退出？有无 headless/CLI/SDK 入口？token/turn/工具预算硬上限？
3. **多并发隔离**：pi 能否同进程/多进程跑多实例（每项目一 worker）？subagent 机制的并发隔离？per-instance context/skill/预算独立？
4. **可复用领域专长（最大优势面）**：pi 的 skill 机制在 headless 下能否确定性调用（非人按需加载）？多 skill 选择、context 预算、MCP auth 的 headless 处理？**迁移代价最低**——用户已有 skill 直接复用，评估这条的可行性分量。

额外：pi 与"本地执行 + .m2 复用"形态的契合度（pi 本就跑在本地，天然访问宿主 FS，沙箱张力如何处理）。

## 如何验证

- pi 文档：`/Users/earthchen/.local/share/pnpm/store/v11/links/@earendil-works/pi-coding-agent/0.83.0/e6ab0700319567cdfd4d94d12fb1ba6e1eacc37ce6f950dcbdef173048c3d4e5/node_modules/@earendil-works/pi-coding-agent/README.md` 及 `docs/`、`examples/`（extensions/custom tools/SDK）。
- 环境变量文档（docs/environment-variables.md）、SDK 集成（docs/sdk.md）、自定义 provider（docs/custom-provider.md）。
- pi 的 headless/CLI 运行入口（如 `pi -p` / `--print` / SDK 调用）实测或文档查证。

## 产出

研究 brief，写入 `/Users/earthchen/ai-work/ci-bot/research/r4-pi-as-bot.md`（目录不存在则建）。区分 **[事实]** / **[未知]** / **[推论]**。末尾给一行对比小结 + 迁移代价评估（pi 这条预期最低，需证实）。
