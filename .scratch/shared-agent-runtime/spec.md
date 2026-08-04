# 共享 Agent Runtime 与静态 Vertical Agent

## Problem Statement

当前 CI 自愈 bot 已实现 Pi session、模型与认证、私有 worker、预算和可信资源加载，但这些执行能力耦合在 CI 专属的 AgentRunner 中。新增代码评审、文档或其他内部 Vertical Agent 时，若各自重建 Pi runtime，会导致模型策略、认证、worker 隔离、预算和资源加载规则重复并逐渐漂移。

用户希望当前项目提供统一的 Agent 能力层，让不同 Vertical Agent 只提供业务 prompt、追加式 system instruction、skills 和轻量业务输入/输出适配，而复用同一套 Pi 模型配置、多 worker 机制和执行生命周期。首版面向可信内部项目，不构建 SaaS 多租户控制面、动态插件平台或通用业务工作流引擎。

## Solution

引入共享 Agent Runtime，并将当前 CI 自愈作为第一个静态注册的 Vertical Agent。

共享 runtime 负责 Pi session 生命周期、统一认证与模型策略、worker 生命周期、预算、超时、可信资源加载和运行事实记录。Vertical Agent 以受 TypeScript 类型检查的静态 definition 注册，声明 agent ID、资源、命名 model policy、命名 capability profile 和业务输入到任务 prompt 的映射。

共享 runtime 保留 Pi 默认 system prompt；Vertical Agent 只能追加 system instruction，不能替换默认 prompt。Vertical Agent 只可请求已发布的内建 capability profile，不能通过 prompt、skill 或配置获得任意工具权限。

runtime 默认不要求结构化输出、JSON Schema、外部验证或业务成功判定。普通 coding Agent 在 skill 内自行验证。CI 自愈保留既有独立 G3、测试、flaky 和 MR gate，因为它会自动产生 MR 这一外部副作用。

## User Stories

1. 作为内部 Agent 平台维护者，我希望统一维护 Pi 认证、模型候选和 profile，使所有 Vertical Agent 使用一致且可审计的模型运行策略。
2. 作为 Vertical Agent 作者，我希望通过静态 TypeScript definition 声明 Agent 资源和策略，使我无需重建 Pi session、worker 或认证逻辑。
3. 作为 CI 自愈维护者，我希望 CI 修复继续使用既有诊断、测试验证和 MR gate，使抽取 runtime 后不改变当前修复边界。
4. 作为 coding Agent 作者，我希望在 skill 内自行运行测试和修复循环，使通用 runtime 不强制 JSON 输出或外部验证器。
5. 作为文档或分析 Agent 作者，我希望返回文本或文件产物，使业务结果不被 CI 专属 schema 限制。
6. 作为运行人员，我希望每个运行继续拥有独立 worker、Pi 目录、预算、超时和清理，使不同 Agent 不共享可写 session 状态。
7. 作为安全负责人，我希望 Vertical Agent 无法通过 prompt 或 skill 直接指定 provider、API key、任意 shell authority 或 worker 并发，使执行权限仍由 runtime 控制。
8. 作为使用者，我希望 Pi 默认 system prompt 和工具说明始终保留，使不同 Agent 的追加 instruction 不会破坏基础工具指导。
9. 作为维护者，我希望 runtime 只返回执行事实和产物引用，而由业务 Agent 或调用方解释业务成功，使共享层不演变为通用 workflow engine。
10. 作为未来的 Agent 作者，我希望新增第二个 Vertical Agent 时复用 runtime 的模型、worker、预算和资源加载能力，而不是复制 CI runner。
11. 作为审计使用者，我希望运行结果仍包含 session 状态、用量、工具轨迹和最终文本/产物引用，使调用方可决定如何消费运行结果。
12. 作为自动化工作流维护者，我希望未来可以为少数高风险 Agent 增加独立验证 gate，但不要求所有 Agent 配置验证器。

## Implementation Decisions

- 建立共享 Agent Runtime，负责 Pi session 创建与执行、模型 policy 解析、认证、受控资源加载、预算、超时、worker 生命周期和运行事实收集。
- 将 Vertical Agent 表示为静态注册、TypeScript 类型检查的 definition；runtime 只接受已注册 agent ID，不依据任务输入或任意文件路径发现 Agent。
- 每个 definition 声明命名 model policy、命名 capability profile、Agent resources 和 `buildPrompt(input)`；`buildPrompt` 将业务输入转换为任务 prompt，runtime 不解释业务对象。
- Agent resources 包含 prompt、skills 和追加式 system instruction。追加 instruction 必须保留 Pi 默认 system prompt，禁止替换 `SYSTEM.md`。
- capability profile 是 runtime 所有的固定内建 Pi 工具 allowlist。第一版不实现自定义工具插件、动态 extension 或动态 MCP 发现。
- model policy 是 runtime 所有的已批准模型候选/profile 策略。Vertical Agent 只能引用 policy 名称，不能传递 provider、model ID、API key 或裸 token budget。
- runtime 只记录中立执行事实，例如状态、用量、最终文本、工具事件和产物引用；不定义跨业务的成功 schema，也不判断业务成功。
- Vertical Agent 默认依靠 prompt/skill 完成自身验证。独立验证及其返工逻辑是可选的业务工作流能力，不是 runtime 的默认能力；CI 自愈继续在其工作流中执行独立 gate。
- 第一版不新增真正的多租户控制面、tenant registry、动态资源上传、通用 workflow DSL、通用 artifact evaluator 或强制 JSON Schema 输出。

## Testing Decisions

- 首选现有 `AgentRunner.run` 与现有 webhook-to-MR e2e 流程作为最高公开回归 seam，验证 CI 行为在抽取后保持不变。
- 为共享 runtime 增加直接的公开执行 seam，验证它将静态 Vertical Agent definition 的资源、模型 policy 和构建后的任务 prompt 传入 Pi session，而不会理解 CI 专属输入。
- 使用既有可注入 session factory seam，避免真实模型网络调用；测试观察 session 创建参数、prompt、预算中止和最终运行事实，而非 Pi SDK 内部实现。
- 保留现有 CI 端到端测试，验证 CI 修复仍创建仅测试文件变更的 MR、预算超限仍升级、CI 独立验证仍控制外部副作用。
- 新增至少一个非 CI 的静态 Vertical Agent fixture，验证第二个 definition 可复用 runtime 而无需复制 session、模型或 worker 逻辑。

## Out of Scope

- 面向不可信外部仓库或 SaaS 客户的多租户身份、数据、网络和凭据隔离平台。
- 动态加载业务 Agent、用户上传 prompt/skill、插件市场或自定义工具执行。
- 让 Vertical Agent 直接定义 provider、模型目录、认证、worker 并发或宿主机权限。
- 所有 Agent 的统一 JSON Schema、统一验证器、统一返工循环或通用业务 workflow engine。
- 改变当前 CI 自愈的 G1/G3、worktree、MR、GitLab、钉钉或人工 review 规则。

## Further Notes

- 当前的 CI 自愈是第一个 Vertical Agent，不是共享 runtime 的业务模型。
- “多租户”在本阶段仅表示多个可信内部 Vertical Agent 复用基础能力；不应被理解为完整的外部租户平台。
- 未来出现第二个需要独立外部 gate 的自动化 Agent 后，再评估是否抽取可选验证 hook。
