# Spike 01 — Pi SDK steer 语义定论

> SDK: `@earendil-works/pi-coding-agent` **0.84.0**（项目 lock 版本）  
> 验证：`tests/spike/steer-semantics.test.ts`（2026-08-20 通过）

## 1. steer 注入时点（长时工具调用）

**结论：turn 边界注入，非立即打断工具。**

| 候选 | 结论 |
|------|------|
| 立即打断正在跑的 bash/mvn | **否** — 无 tool abort 钩子；`steer()` 仅入队 |
| 当前工具完成后、下一次 LLM 调用前 | **是** — 官方语义 + agent-loop 实现一致 |
| 整个 agent run 结束后（followUp 语义） | **否** — 那是 `followUp()` |

### 证据链

1. **类型文档**（`dist/core/agent-session.d.ts`）：
   > Delivered after the current assistant turn finishes executing its tool calls, before the next LLM call.

2. **agent-loop**（`pi-agent-core/dist/agent-loop.js`）：
   - 内层循环：LLM 响应 → 执行 tool batch → `turn_end` → **此时** `getSteeringMessages()` 拉取 steer
   - steer 作为 user message 注入，再进入下一轮 LLM
   - 正在执行的 tool 批次不会被 steer 中断（除非 tool 自身响应 `abort` signal）

3. **RPC 文档措辞**（`rpc-client.d.ts`: "interrupt the agent mid-run"）与实现不一致 — **以 agent-session.d.ts + agent-loop 为准**。

### 对 CI 自愈的影响（退化路径）

- mvn/test 跑到一半时用户 push → agent **最早**在该 turn 全部 tool 完成后才看到 supersede 通知。
- **不变式仍成立**：bot 侧维护 `latestTargetSha`，未送达窗口用 `clearQueue()` + `steer(latest)` 合并；终局新鲜度闸门（ticket 07）兜底过期 MR。
- 审计区分 `steerQueuedAt` / `steerDeliveredAt`，不假设「推送即打断」。

---

## 2. `queue_update` 作为 steer 送达信号

**结论：_enqueue 可靠；_delivery 需组合判断，session 终止时 pending steer 丢失。_

### 事件形状

```typescript
{ type: "queue_update"; steering: readonly string[]; followUp: readonly string[] }
```

### 触发时机

| 时机 | 行为 | 可靠性 |
|------|------|--------|
| `steer()` / `followUp()` 入队 | `_emitQueueUpdate()`，`steering` 含新条目 | **可靠**（同步） |
| steer 被注入为 user message | `message_start` 前从 `_steeringMessages` splice → `_emitQueueUpdate()` | **可靠**（若 session 仍存活且 run 继续） |
| `clearQueue()` | 清空两队列 + `queue_update` | **可靠** |
| worker `dispose()` / run `abort()` 且 steer 未注入 | pending 丢弃，**无** delivery 事件 | bot 须重置 pending 状态 |

### 送达判定（ticket 06 推荐）

Bot **不应**仅凭「收到 queue_update」视为送达：

1. **已入队**：`queue_update.steering.length > 0` 且 bot `pendingSteer !== null`
2. **已送达**：同一 run 内观察到 `queue_update.steering.length === 0`（此前非空），**或** `message_start`（user）内容与 pending payload 匹配
3. **session 终止**：若 worker 结束/abort 时仍 pending → 记 `steerLost`，不当作送达

### session 在送达前终止

- `dispose()` 不抛错，undelivered steer 静默丢失（实测 + 源码 `_steeringMessages` 随 session 销毁）
- 跨进程 supersede 依赖 ticket 05 IPC + worker 内活 session；worker 崩溃时由 session 存档 + 下 event reopen 降级（spec 已有）

---

## 3. 未送达 steer 的内容替换/合并

**结论：SDK 无原生 replace/merge；bot 侧维护 pending 内容 + `clearQueue()` + `steer(latest)`。**

### SDK 行为

- `steer()` → `_steeringMessages.push()` + `agent.steer()` enqueue — **只追加**
- 连调两次 steer → 队列两条，默认 `steeringMode: "one-at-a-time"` 会分 turn 逐条送达
- **唯一替换原语**：`clearQueue()` 返回旧内容并同步清空 agent 内核队列，再 `steer(newText)`

### Bot 侧需维护的状态（ticket 06）

| 字段 | 用途 |
|------|------|
| `pendingSteerPayload` | 最新 supersede 文案（old→new sha、文件清单、是否可收尾） |
| `pendingSteerQueuedAt` | 审计：入队时间 |
| `steerDeliveredAt` | 审计：送达时间（见 §2 判定） |
| `supersededPipelineChain` | 审计：被合并/取代的 pipeline-id 链 |

### 合并算法（spec 不变式）

```
on supersede while worker running:
  if pendingSteerPayload != null:   # 未送达窗口
    session.clearQueue()
  pendingSteerPayload = buildPayload(latestEvent)
  session.steer(pendingSteerPayload)
  emit audit steer_merged if replaced
```

---

## 4. 关联 API 速查

| API | 行为 |
|-----|------|
| `session.steer(text)` | 运行中可调用；turn 边界送达 |
| `session.prompt(text, { streamingBehavior: "steer" })` | 流式中等价于 steer 入队 |
| `session.followUp(text)` | agent 完全停下后才送达 |
| `session.clearQueue()` | 清空 steer+followUp，返回被清内容 |
| `session.getSteeringMessages()` | 只读 pending UI 列表 |
| `session.steeringMode` | `"all"` \| `"one-at-a-time"`（默认后者） |
| `SessionManager.open(path)` | 按 jsonl 路径重开 |
| `SessionManager.list(cwd)` | 列举 cwd 下 session |

---

## 5. ticket 06 实现预期更新摘要

见 `spec.md` Implementation Decisions §2 修订：明确 turn 边界退化、clearQueue 合并、送达双信号、审计字段。
