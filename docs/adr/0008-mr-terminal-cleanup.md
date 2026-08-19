# MR Terminal Cleanup (merge/close)

When a repair MR reaches a terminal state (merged or closed), the bot state tied to that MR loses its purpose: the per-MR session archive can never be reused (no future pipelines on a merged/closed MR), and an awaiting decision whose subject MR is gone can only produce a resume run against a dead branch. Without an explicit terminal hook this state lingered until passive eviction (LRU cap on `mr-sessions`, TTL sweep on decisions) — and during that window a human could still `/heal` a decision whose MR no longer exists. The receiver now consumes GitLab `merge_request` events (`action=merge|close`) and cleans up synchronously.

## Mechanism

1. **Event intake**: `mountWebhook` parses `object_kind=merge_request` after the shared security chain (IP allowlist → rate limit → X-Gitlab-Token). Only `action=merge|close` normalize into a `MrTerminalEvent { projectId, mrIid, action: merged|closed }`; `open/update/reopen` etc. fall through to the existing ignore path. Response is always `202 mr-terminal` — hook errors are caught and logged, never surfaced.
2. **Decision cleanup**: `DecisionLifecycle.onMrTerminal` lists the project's decisions, keeps `awaiting_decision` rows whose `event_json.mrIid` matches, transitions them to `invalidated` with `decided_by=system:mr-terminal`, and cleans each retained scene (same `cleanupRecordScene` seam as T07/T08). Silent by design: MR merge/close is normal lifecycle, no group notification.
3. **Session archive cleanup**: `removeMrSession(projectId, mrIid)` deletes the `<proj>-<mr>.jsonl` archive plus meta sidecar from `DATA_ROOT/mr-sessions`. Idempotent; best-effort; returns whether an archive existed.
4. **Composition**: `main.ts` wires the receiver hook to both cleanups (lifecycle first, then archive removal). For MRs the bot never touched both are no-ops — the handler is safe for every merge_request event the GitLab instance sends.

## Why webhook events, not polling

- **Polling the MR state** (via `fetchMrPipelineStatus`-style glab calls) only works inside the repair MR monitor loop, i.e. during the worker's lifetime (minutes after MR creation). The dominant case — human review lasting hours to days, then merge — happens long after the worker exited, invisible to any poller.
- **Webhook events** arrive whenever the MR terminates, reuse the receiver's existing security chain, and cost one small handler. Price: each GitLab project's webhook config must enable **Merge request events** in addition to Pipeline events (operational step, documented in README / real-run-playbook / docker-deployment).
- **Doing nothing** (rely on LRU/TTL) leaves the `/heal`-a-dead-MR window open for up to 24h and wastes the 32-slot session archive on dead MRs.

## What is deliberately NOT cleaned

- **Bare clone cache** (`DATA_ROOT/bare/`): shared across MRs/pipelines of a project; passive LRU pruning already covers it.
- **Audit traces**: retention-policy domain (`DATA_ROOT/audit/`), independent of MR lifecycle.
- **Remote repair branch**: GitLab deletes it on merge (`--remove-source-branch=true` set at createMr).

## Risks and mitigations

- **Lost webhook event** (GitLab delivery failure): degrades to the previous behavior — passive LRU/TTL eventually reclaims everything. No correctness risk, only later cleanup.
- **Merge events for human MRs** the bot never saw: both cleanups miss and no-op; cost is one SQLite list query + one `existsSync` per event.
- **Race with an in-flight repair of the same MR**: if a human closes an MR mid-repair, cleanup may run while the worker still holds its scene. Terminal scene cleanup is best-effort and the worker's own `finishRepair` cleanup remains authoritative — worst case a redundant warning log.

## Consequences

- New normalized event type `MrTerminalEvent` and a second webhook `object_kind` accepted by the receiver; the GitLab webhook contract widens (Merge request events required for timely cleanup, optional otherwise).
- `DecisionStore.updateStatus` gains a second system caller (`system:mr-terminal` alongside `system:new-pipeline`); `decided_by` in the audit trail distinguishes them.
- mr-sessions LRU pressure drops in steady state (dead MR archives removed at MR terminal instead of at capacity eviction).
