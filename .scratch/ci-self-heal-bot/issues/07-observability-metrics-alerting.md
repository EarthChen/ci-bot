# 07 — Observability (structured logs, SQLite metrics, per-fix trace, bot self-failure DingTalk)

**What to build:** Instrument the bot per G7. Structured JSON logs for all operations; lightweight metrics in SQLite/file (no external dependencies like Prometheus/Grafana in v1). Per-fix trace captures project / failure-class / turns / tokens / cost / result / MR-link for individual fix auditing. Aggregate metrics: success rate, average fix duration, cost-per-fix. Bot self-failures (webhook endpoint unreachable, all workers dead, model quota exhausted) trigger DingTalk alerts (extends the G2 fix-result DingTalk channel). Cost estimate formula wired (single fix 5k-20k tokens; monthly peak = N × daily-fixes × tokens × unit-price × 30).

**Blocked by:** 01 (tracer bullet — needs a pipeline to instrument)

**Status:** ready-for-agent

- [ ] Structured JSON logs for all bot operations (webhook receive, queue, spawn, agent run, verify, MR, notify)
- [ ] SQLite (or file-based) metrics store, no external dependencies
- [ ] Per-fix trace: project / failure-class / turns / tokens / cost / result / MR-link
- [ ] Aggregate metrics: success rate, average fix duration, cost-per-fix
- [ ] Bot self-failure DingTalk alerts: webhook unreachable, all workers dead, quota exhausted
- [ ] Cost estimate formula wired (single fix token range + monthly peak formula); values TBD empirically
- [ ] Evolution seam documented: Prometheus + Grafana later
- [ ] Tests assert: per-fix trace written for a fixture fix; self-failure DingTalk fires on simulated bot-down
