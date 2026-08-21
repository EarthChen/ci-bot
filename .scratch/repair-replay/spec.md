# Repair Replay & MR-Terminal Repair Gate

> 来源：2026-08-21 生产实查（pipeline 100034349 在 MR !432 合并后 2 分钟触发盲修，30+ 分钟 token 白耗）+ grilling 共识（两轮全部同意）。

## 目的 / 结论

同 MR 后续 pipeline 的处置语义补全：

1. **MR 终局跳过闸门**：源 MR 已 merge/closed 时不再开修（现状缺口：绿灯短路只查 pipeline 状态，不查 MR 终局状态）。
2. **修复重放（repair replay）**：源 MR 未合并的同 MR 新 pipeline，把上轮已 push 的修复改动 git 层重放进新 worktree，agent 只处理增量——现状只复用 session（重新诊断省了），修复动作本身要重做（40+ turns 的大头）。

## 背景事实（已核实）

- `realWorktree` 每次 `worktree prune` → 删修复分支 → 新 sha 上重建 worktree，上轮修复的工作区改动被主动丢弃。
- `pushRepairBranch` 会 commit 并 **force-push**，上轮修复以 commit 形式活在 origin 修复分支（fix MR 的 source branch）上。
- `mr-session-store` meta 已存 `{pipelineId, sha}`——base sha 零新增存储。
- bare clone refspec 负向排除 `ci-self-heal/*`（!281 教训，防修复分支回流污染）。
- 上一轮 100034275 诊断原话：「开发者新提交 226502fb 不含上轮修复，原违规复现」。

## 方案

### MR 终局跳过闸门

- 出队执行前（绿灯短路同一位置）查源 MR state。
- `merged|closed` → 跳过修复：不 spawn worker、群通知尾注「源 MR 已合并/关闭，跳过自愈」、审计记录。
- MR state **查询失败 fail-open**（放行修复，维持现状）——闸门是省钱优化不是安全边界，误跳过（该修没修）代价大于误开修。

### 修复重放

```text
新 pipeline（同 MR、未合并、origin 修复分支有非空修复 commit）
  → worktree 照常新建（目录永不复用）
  → 单次 git fetch origin <repairBranch>（FETCH_HEAD，不动全局 refspec）
  → git diff <meta.sha>..FETCH_HEAD | git apply -3
  → applied / empty：prompt 注入说明；conflict：原子清理降级；skipped：现状
```

- **重放单位**：range-diff + `apply -3`，不用 cherry-pick（要的是工作区改动不是 commit 历史；`pushRepairBranch` 反正重新 commit；empty 天然 no-op）。
- **人工 commit**：origin 修复分支上的人工 push 照带重放，G3 白名单兜底。
- **降级**：apply 非零退出即原子清理工作区，审计记 conflict，退回全新修复（session 复用照旧兜底）。不做半重放。
- **prompt**：applied →「上轮修复已重放到工作区，先验证再只修增量」；empty →「上轮修复已包含在新代码中，勿重做」；conflict/skipped → 不注入。
- **G3 交互**：重放改动越出新 MR diff hunk ±5 → 整体走现有 `validatePatchLineScope` 转交/决策路径（ADR-0009），不做部分重放。
- **push 语义**：维持 force-push 改写（现状每次重试本就如此），approve 重置可接受。

## 审计 / 指标

- audit trace 增 `replay: { fromPipeline, commitRange, outcome: applied|empty|conflict|skipped }`。
- metrics.jsonl 增重放 outcome 计数。

## 词汇

见 `CONTEXT.md` **Repair replay** 词条（已落）。

## 验收

- 单测：applied / empty no-op / conflict 降级 / 无上游分支跳过 / 含人工 commit 五路径 + 终局闸门 merged/closed/open/fail-open 四路径。
- e2e（stub）：(a) pipeline A 修复开 MR → 同 MR pipeline B 失败 → 重放 + 增量修复 → force-push 原地更新修复 MR；(b) MR 已合并后 pipeline 到达 → 跳过。
- 覆盖率红线 ≥80% 不变。

## Tickets

| # | 标题 | Blocked by |
| --- | --- | --- |
| 01 | MR 终局跳过闸门 | — |
| 02 | 修复重放核心（四路径） | — |
| 03 | e2e：同 MR 二次 pipeline 全链路 | 01, 02 |
| 04 | ADR-0012 + 文档同步 | 02（01 一并收尾） |
