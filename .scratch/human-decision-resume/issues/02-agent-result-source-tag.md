# 02 — AgentResult 来源标记 + 可决策判定

**What to build:** runRepair 能区分"agent 主动 escalated"与"runner 生成的 escalated"，为现场保留提供判定依据。纯类型+解析变更，无运行时副作用。

**Blocked by:** None — can start immediately

**Status:** ready-for-agent

- [ ] AgentResult escalated 类型新增 `source: "agent" | "runtime"` 字段
- [ ] result-parser 产出 `source: "agent"`
- [ ] real-runner 的 escalateBudget / escalateError 产出 `source: "runtime"`
- [ ] runRepair 中新增 `isDecidableEscalation(result)` 函数：仅当 source === "agent" 且 diagnosis 存在时返回 true
- [ ] unit test：覆盖三类 escalated（agent/budget/parse）的分类正确性
