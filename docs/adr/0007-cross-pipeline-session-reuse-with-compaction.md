# Cross-Pipeline Session Reuse with Compaction

When a pipeline of an MR that the bot repaired before fails again (requirement re-iteration or requirement change on the same MR), the new repair re-opens the previous MR's archived Pi session, compacts it, and continues — instead of starting a cold session. Real e2e telemetry (MR !281 runs 5/6: 36–52 turns, ~3–6M tokens per run) showed roughly 30% of every run is re-orientation the session already paid for once: repo/module map, build-system quirks (`mvn -pl <m> -am`), prior root-cause analysis. Reuse converts that from per-run cost to one-time cost.

## Mechanism

1. **Archive (store)**: any terminal that produced an MR artifact (`outcome=mr`, or escalated with a partial-fix `mrUrl`) copies the Pi session jsonl from the worker scene (`<cwd>/.pi-agent/sessions/`, about to be cleaned up) into `DATA_ROOT/mr-sessions/<projectId>-<mrIid>.jsonl` + meta sidecar. Latest-wins per MR; LRU cap 32 MRs. Push pipelines (no mrIid) are not archived.
2. **Reuse**: `runRepair` looks the store up by MR; on hit it copies the archive into the new worker (`<cwd>/.pi-agent/sessions/reuse/`) — the store stays read-only and re-archives latest-wins at terminal — and passes `reuseSessionFile` + `reuseMeta` into the agent input. Miss or copy failure degrades to a fresh session (loud log, never blocks).
3. **Open + compact + continue**: `createDefaultSession` re-opens the copy via `SessionManager.open` (same seam as T06 `/heal` resume) and, for reuse, calls `AgentSession.compact()` — the programmatic form of `/compact` in pi-coding-agent 0.84.0: one summarization call compresses the old context into a summary + `keepRecentTokens`, which becomes the starting context of the continued run. Compaction is best-effort: any failure continues uncompacted.
4. **New-commit declaration**: the reuse prompt states explicitly that the MR has advanced to a new commit (old sha/pipeline → new sha/pipeline), that summary conclusions apply only to the old commit, and that intent determination must run fresh — never inherit the old diagnosis.
5. **Audit**: the trace carries `reusedFromPipeline` so a reused run is traceable back to the session it continued.

## Why copy, not resume in place

The original session file lives in a per-event uuid worker directory that terminal cleanup deletes; its path is unaddressable for a later worker, and `SessionManager.continue` only finds sessions under the same cwd. Copying to a per-MR stable address before cleanup is the minimal persistence. The alternative (retaining whole scenes per MR, worktrees included) costs orders of magnitude more disk and entangles two lifecycles; worktrees are cheap to recreate (seconds, from the shared bare clone) while session context is expensive — retain the expensive artifact, recreate the cheap one.

## Risks and mitigations

- **Stale-diagnosis anchoring**: the summary carries old root-cause conclusions; a genuinely unrelated new failure could anchor the agent backwards. Mitigated by the mandatory new-commit declaration + fresh intent determination, with the G3 gate and human MR review as backstops. Residual risk accepted: the dominant real-world case is same-requirement iteration, where the old context is an asset.
- **Compaction cost**: one summarization call (~a turn and a half of tokens) per reuse — paid only when reuse happens, recouped within the same run.
- **SDK coupling**: reuse depends on `AgentSession.compact` and `SessionManager.open` (0.84.0 surface). The degrade chain keeps a failed reuse from becoming a failed repair.

## Consequences

- Expected savings per reused run: ~30–40% tokens for same-requirement iteration, ~15–25% for requirement changes (re-orientation eliminated, diagnosis partially inherited); compounding across an MR's failure rounds.
- `DATA_ROOT/mr-sessions` is a new persistent directory (paths.ts `resolveMrSessionsDir`); retention is LRU-by-mtime under the cap.
- T06 `/heal` resume and cross-pipeline reuse share the `resumeSessionFile` seam; only reuse sets `compactForReuse`.
