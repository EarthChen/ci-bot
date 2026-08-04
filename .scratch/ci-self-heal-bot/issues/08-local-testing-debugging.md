# 08 — 本地测试与调试机制（bot dry-run + fixture 仓库 + replay + trace）

**要构建什么：** 为 bot 专属风险（headless 下 skill 是否真触发、compaction 配置行为、预算软上限刹车、管道全链）建立本地验证机制，不依赖真 GitLab/真 MR/真钉钉。包含四件：(1) fixture 仓库——小 Java/Maven 项目故意埋 class 1/2/3 失败 + 配套 spec 目录；(2) dry-run 模式——`BOT_DRY_RUN=true` 时 agent 真跑真 LLM、MR 写本地文件、钉钉写本地 trace、验证真跑 mvn test（fixture 仓库，安全）；(3) webhook replay——录制 payload 到 `fixtures/webhooks/`，`bot replay <file>` 重放，改配置前后对比；(4) trace 可视化——每轮记录 context 占用 + turn_end + skill 加载 + tool 调用链，JSON 供人读。skill 内容调优不在本票——在项目内起 pi 交互 session（`cd ci-bot && pi`，自动发现 `.agents/skills/`）做，定型后进 bot dry-run 复验 headless 触发。

**Blocked by:** 01（tracer bullet——需要 01 的管道骨架和测试接缝）

**Status:** ready-for-agent

- [ ] fixture 仓库 `fixtures/repo/` 落地：小 Java/Maven 项目（pom.xml + Calculator + CalculatorTest）+ `docs/spec/calculator.md` + `.git/`（有 history 能模拟 pipeline）
- [ ] fixture 仓库埋三类失败：class 1（断言错）、class 2（被测代码变更致测试过时）、class 3（测试缺失，spec 可读）；通过切 branch/commit 触发不同类
- [ ] dry-run 模式 `BOT_DRY_RUN=true`：agent 真跑（真实 createAgentSession + 真 LLM 调用，不 mock）；MR 创建 → 写本地 `fixtures/mr-output/`；钉钉 → 写本地 `fixtures/dingtalk-trace/`；验证 → 真跑 `mvn test`（fixture 仓库，安全）
- [ ] webhook 录制与重放：`bot record-webhook` 录一次真实 payload 到 `fixtures/webhooks/<class>.json`；`bot replay fixtures/webhooks/class1.json` 重放，同一 payload 改配置前后对比
- [ ] headless skill 触发 trace：每轮记录 `/skill:ci-self-heal-playbook` 是否真触发（R2 核心风险点——交互式有人接住"模型跳过 skill"，headless 没人）；trace 写 `fixtures/trace/<run-id>.json`
- [ ] compaction 专项验证：制造能灌超长 context 的 fixture（大量源码文件），跑 bot，trace 记录每轮 context 占用曲线；验证 ratio 0.8 在 256k cap 下确实在 ~204k 触发、压缩后基线确实降到 ~41%（不是 60%）
- [ ] 预算软上限刹车验证：制造大 tool call 单 turn 超支场景，验证 turn_end + session.abort + 钉钉告警是否生效；记录"单 turn 内超支窗口"实际大小
- [ ] trace 可视化：JSON trace 含每轮 context 占用 / turn_end 事件 / skill 加载记录 / tool 调用链 / abort 事件；人可读（pretty-printed JSON 或简单 markdown 摘要）
- [ ] skill 调优路径文档化：在 `fixtures/README.md` 写明"bot 专用 skill 调优 = `cd ci-bot && pi` 起交互 session，pi 自动发现 `.agents/skills/`，调完 SKILL.md 进 bot dry-run 复验 headless 触发"
- [ ] 02 实现期的调优工作流文档化：本地 pi 交互（快、人在线，调 skill 内容/prompt 措辞/基本诊断）→ bot dry-run（慢、自动化，验 headless skill 触发/compaction/预算/全链）→ 真 GitLab（生产）

**反例（设计已知风险，不藏）：**
- compaction 专项慢且贵：要真 LLM 灌到 204k 才触发压缩，跑一次几分钟 + 真实 token 成本；不能进常规 CI，只能手动跑
- fixture 太简单会失真：单模块小项目测不出多模块 Java 项目里 skill 的真实效果；取中——fixture 覆盖 G1 三类 + 至少一个多模块结构
- observational-memory 最难本地测：观察/反思依赖真实 session 历史积累，短 fixture 触发不了；只能靠真实长 session 观察，本地难复现（标注为已知 gap）
