---
name: ci-self-heal-playbook
description: CI 单元测试失败自愈 playbook。当 GitLab pipeline 单测失败、需要诊断根因并修复测试（绝不碰生产代码）时加载本 skill。覆盖诊断（G1 五类分类法）、修复（G3 权限边界 + 每类修复步骤）、文档同步（G2 只动相关段落）三段。
---

# CI 单测自愈 Playbook

本 skill 指导 agent 处理 GitLab pipeline 单元测试失败：诊断根因 → 修复测试 → 同步文档 → 输出结构化结果。

**铁律（违反任一即转交人工，不得开 MR）：**

1. **只改测试 + 文档**。`src/main/`（生产代码）绝对禁止触碰。发现失败根因在生产代码 → **class 5 转交人工**（class 2 是测试过时，应自动修测试，不转交）。
2. **class 3（缺失测试）按 spec/PRD 断言正确行为**，不得按当前代码行为断言（否则会把 bug 固化成测试）。
3. **不猜测修复**。诊断未达 class 1/2/3 确信 → 转交，不多次重试烧预算。
4. **结构化输出**。session 结束必须输出 `fixed`（diagnosis + summary + mrUrl）或 `escalated`（diagnosis + reason）。
5. **绝不 `glab mr merge`**。你可 `git push` + `glab mr create` 提交 MR 供人工 review，但**严禁自动合并**——所有 MR 必须人工 review 后 merge。

---

## 一、诊断（G1 五类分类法）

从 CI 日志 + MR diff + 源码定位根因，归入五类之一：

| class | 含义 | v1 处理 |
| --- | --- | --- |
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
4. 跑**所改测试类**确认绿（用项目实际构建工具，如 Maven `mvn test -Dtest=<简单类名>` / Gradle `./gradlew test --tests <类>` / pnpm / pytest；**多模块项目在所属模块目录跑，勿在 reactor 根跑**）。**勿因其他无关测试失败而 revert 本次改动**；仅当所改测试本身仍红才回退。
5. **提交 MR**（prompt 会给源/目标分支）：`git add` → `git commit -m 'fix: ...'` → `git push origin <源分支>` → `glab mr create --source-branch <源分支> --target-branch <目标分支> --title '<标题>' --description '<正文>' --yes`。从 `glab mr create` 输出取 MR web_url 填入 `fixed.mrUrl`。glab 在 worktree 内自动识别 remote，**勿传 `--project`**（该 flag 无效）。**必须自己 push + create MR，不得引用现有 MR URL 跳过提交**——即使内容类似已有 MR，你的 MR 针对当前 pipeline 独立 review；引用他人 MR URL 会被 bot 判为未提交。

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
  "summary": "修正断言期望值为 5",
  "mrUrl": "https://git.example.com/group/repo/-/merge_requests/123"
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

**注意**：`fixed` 含 `diagnosis` + `summary` + `mrUrl`，**没有** `fix` 字段。**你自己提交 MR**（`git add` → `git commit` → `git push origin <源分支>` → `glab mr create`），把 MR 的 web_url 填入 `mrUrl`。bot 从 `mrUrl` 驱动钉钉通知与 audit；不信任 agent 自述 patch 内容（bot 仍从 `git diff` 提取真实 diff 留 audit）。`mrUrl` 空 → bot 视为未建 MR → 转交。未输出合法 JSON → bot 视为失败。

## 通用语言 skill

处理 Java 单测时，先读 `java-coding-standards`（全局 skill）了解 Java 命名/断言/mock 规范。本 playbook 只管 CI 自愈流程，不重复语言规范。
