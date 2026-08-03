# G1: 单测失败的分类法

> **wayfinder:grilling** · 状态: open · 类型: HITL（需用户在线，/grilling）· assignee: unclaimed
>
> **Blocked by**: —

## Question

bot 要"对症下药"修单测，先得把单测失败分成有限几类，每类对应不同修复策略（G3）。这个分类法是路由（G2）和修复策略（G3）的输入。

候选维度（grilling 时逐个确认）：
- **根因**：测试本身有 bug / 被测代码变更致测试过时 / 测试缺失 / 环境/flaky / 断言写错。
- **修复动作**：改测试 / 改被测代码 / 补新测试 / 改文档。
- **Java 特定**：JUnit 版本、Mockito stub、Spring context 等。

分类须 MECE、有限（≤6 类）、可从 CI 日志 + git diff 自动判定类别（否则 bot 无法路由）。

## 产出

分类法表（类别 × 判定信号 × 默认修复动作 × 是否触发文档同步）。归档 `research/g1-taxonomy.md`，ticket 留 pointer。
