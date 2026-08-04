# 05 — Concurrency & scheduling (N>1, per-project serial, cross-pipeline expiry, backpressure)

**What to build:** Scale the scheduler from N=1 to a global concurrency cap N with overflow FIFO queue (no drop), per-project serial queues (one project's failures don't block another), and cross-pipeline expiry (when a new push arrives while an old pipeline is running or queued, the worker finishes the current pipeline, then takes the latest queued; the stale-commit MR is marked "rebase or discard" + DingTalk). Multiple workers run in parallel with per-worker isolation (PI_CODING_AGENT_DIR + --session-dir + cwd). Queue-too-long triggers DingTalk alert for human intervention.

**Blocked by:** 02 (real pi agent — needs a working fix to scale)

**Status:** ready-for-agent

- [ ] Global concurrency cap N (configurable, value TBD empirically per deploy machine)
- [ ] Overflow FIFO queue (no drop); queue-too-long → DingTalk alert
- [ ] Per-project serial queue (cross-project parallelism, intra-project serial)
- [ ] Cross-pipeline expiry: current pipeline runs to completion, then take latest queued; stale-commit MR marked "rebase or discard" + DingTalk (no interrupt, doesn't waste consumed turns)
- [ ] Per-worker isolation: PI_CODING_AGENT_DIR + --session-dir + cwd (pi shared-state isolation)
- [ ] End-to-end fixtures: same pipeline retried → one fix; pipeline B arrives while A running → A finishes then B, A's MR marked stale; concurrency at cap N → event queued not dropped
