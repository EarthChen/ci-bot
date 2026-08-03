# G4: 每项目独立 worker 的并发模型

> **wayfinder:grilling** · 状态: open · 类型: HITL（需用户在线，/grilling）· assignee: unclaimed
>
> **Blocked by**: R1（需 SDK 并发能力结论）

## Question

用户已选"每项目独立 worker 并行"。本 ticket 把它 grilling 到 spec 级别：worker 怎么供给、怎么调度、怎么隔离、资源怎么管。

1. **worker 供给**：长驻 pool（每项目常驻一个 worker 进程）vs 按需 spawn（事件来才起）？worker 进程/线程/SDK-agent-instance 哪一级？
2. **隔离**：每 worker 独立 git worktree/clone（避免并发写冲突）、独立 context/预算、独立模型配额。项目级配置怎么加载。
3. **状态与去重**：同一项目短时间内多次失败事件——去重/合并/排队？worker 正在修时新事件怎么处理（忽略、排队、打断）？
4. **背压**：worker 数上限、内存/CPU/模型配额耗尽时的拒绝策略。

## 产出

并发模型设计（供给/隔离/调度/背压），含一项目同时多失败的处理规则。归档 `research/g4-concurrency.md`。
