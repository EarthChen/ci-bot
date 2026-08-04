---
name: ci-self-heal-playbook
description: CI 单元测试失败自愈 playbook。当 GitLab pipeline 单测失败、需要诊断根因并修复测试（绝不碰生产代码）时加载本 skill。覆盖诊断（G1 五类分类法）、修复（G3 权限边界 + 每类修复步骤）、文档同步（G2 只动相关段落）三段。
---

# CI 单测自愈 Playbook

本 skill 指导 agent 处理 GitLab pipeline 单元测试失败：诊断根因 → 修复测试 → 同步文档 → 输出结构化结果。

**铁律（违反任一即转交人工，不得开 MR）：**

1. **只改测试 + 文档**。`src/main/`（生产代码）绝对禁止触碰。发现失败根因在生产代码 → class 2/5 → 转交。
2. **class 3（缺失测试）按 spec/PRD 断言正确行为**，不得按当前代码行为断言（否则会把 bug 固化成测试）。
3. **不猜测修复**。诊断未达 class 1/2/3 确信 → 转交，不多次重试烧预算。
4. **结构化输出**。session 结束必须输出 `fixed`（diagnosis + fix）或 `escalated`（diagnosis + reason）。

---

## 一、诊断（G1 五类分类法）

从 CI 日志 + MR diff + 源码定位根因，归入五类之一：

| class | 含义 | v1 处理 |
|---|---|---|
| 1 | 测试 bug（断言/mock/数据错） | 自动修 |
| 2 | 被测代码变更导致测试过时 | 自动修 + 文档同步 |
| 3 | 缺失测试（新代码路径无覆盖） | 按 spec 补测试 |
| 4 | flaky/环境问题 | 转交人工 |
| 5 | 非单测失败（编译/依赖） | 转交人工（bot 代码已早筛，agent 仍需复核） |

**判定信号速查**（详表见 [diagnosis detail](references/diagnosis-detail.md)）：

- class 1：断言期望值与被测代码实际行为不符（如 `assertEquals(4, calc())` 但 `calc` 正确返回 5）；mock 返回值过时；测试数据硬编码错。
- class 2：被测代码签名/行为变了，测试没跟上（看 MR diff 被测代码改了，测试未改）。
- class 3：CI 日志显示某路径未覆盖（新增分支无测试），或 spec 要求的行为无测试。
- class 4：本地跑过、CI 失败；时间相关；网络/外部依赖抖动。
- class 5：`BUILD FAILURE` 编译错；`cannot resolve` 依赖错；非 test phase。

## 二、修复（G3 权限边界 + 每类步骤）

**权限边界**：只允许写 `src/test/`、`src/it/`（测试目录）与 `docs/`、`*.md`（文档）。任何 `src/main/` 路径 → 转交。

**class 1 修复步骤**：
1. 读被测代码确认正确行为（不要猜，读源码）。
2. 读失败测试，定位错在断言/mock/数据哪一处。
3. 改测试使其断言正确行为。**不改被测代码**。
4. 跑**相关测试**（只跑失败的那个测试类，全量回归是 ticket 04）确认绿。

**class 2 修复步骤**：
1. 读 MR diff，理解被测代码变更了什么。
2. 判定测试过时点：签名变了 → 改测试调用；行为变了 → 改断言期望。
3. 修复测试。**同步文档**（见三）。
4. 跑相关测试确认绿。

**class 3 修复步骤**：
1. 读 spec/PRD，确定**期望的正确行为**（不是当前代码行为）。
2. 写测试断言该行为。若发现被测代码与 spec 不符 → 转交（不得改生产代码，也不得按 bug 行为写测试）。
3. 跑新测试确认绿（若红了且 spec 明确，可能是 class 2——被测代码改漏了）。

**class 4/5**：输出 `escalated`，reason 写明 class + 信号。

详表见 [repair detail](references/repair-detail.md)。

## 三、文档同步（G2）

**时机**：仅 class 2（被测代码行为变更）触发。class 1/3 不触发。

**规则**：
- 只改**与变更行为直接相关的段落**（API 描述、参数语义、返回值说明）。
- 不做全文重写、不改格式、不动无关段落。
- 若无相关文档 → 跳过（不补新文档）。

详表见 [doc-sync detail](references/doc-sync-detail.md)。

---

## 输出格式

session 结束前，最后一条 assistant message 必须是 JSON（代码块包裹），结构：

```json
{
  "kind": "fixed",
  "diagnosis": { "failureClass": 1, "summary": "CalculatorTest 断言期望 4，实际应为 5（2+3）。修正断言。" },
  "fix": { "files": [{ "path": "src/test/java/.../CalculatorTest.java", "content": "..." }], "summary": "修正断言期望值为 5" }
}
```

或：

```json
{
  "kind": "escalated",
  "diagnosis": { "failureClass": 4, "summary": "flaky：本地通过 CI 失败，含时间相关断言" },
  "reason": "class 4 flaky，转交人工确认"
}
```

bot 代码解析此 JSON 驱动 MR 创建 / 转交 / 钉钉通知。未输出合法 JSON → bot 视为失败。

## 通用语言 skill

处理 Java 单测时，先读 `java-coding-standards`（全局 skill）了解 Java 命名/断言/mock 规范。本 playbook 只管 CI 自愈流程，不重复语言规范。
