# CI Repair — G3 Relaxation (Diff-Scoped src/main) + Session-Reuse Retry

The original G3 boundary forbade **all** `src/main` edits, so the CI self-heal
agent could only fix test/doc files. Pipeline failures also include static
analysis (SpotBugs/PMD) and Checkstyle, whose violations frequently land in
production code. Because every MR is human-reviewed (no auto-merge), relaxing
the boundary for deterministic, behavior-preserving fixes is safe **if** the
blast radius is bounded.

## Decision

1. **G3 becomes a diff-whitelist, not a hard `src/main` ban.** The bot accepts a
   patch only when every changed path lies within the MR diff file set. For
   **test** failures the agent may still only touch `src/test|it`/`docs`. For
   **static-analysis / Checkstyle** failures the diff-scoped `src/main` files
   are editable. Build/CI config (`pom.xml`, `build.gradle`, `.gitlab-ci.yml`,
   `Dockerfile`) is always forbidden, even inside the diff.
2. **Guardrails:** no suppression-only fixes (`@SuppressWarnings` / Checkstyle
   suppression / rule deletion); edits bound to the reported `file:line:rule`;
   if a fix needs a file outside the diff → escalate.
3. **Unit-test G3 is unchanged:** the agent must never edit `src/main` to make a
   failing unit test pass (this is the "illegitimately make tests pass" trap G3
   was built to prevent).
4. **MR-CI monitoring + session-reuse retry:** after the agent opens an MR, the
   bot polls that MR's head pipeline (the same gate that failed). On red, the bot
   **reuses the in-worker agent session** (session stays alive in the worker
   subprocess), injects the new CI log, and instructs the agent to `git push`
   to the **same branch** (updating the MR — not creating a new one), up to
   `CIHEAL_RETRY_LIMIT` times, then escalates. The MR-CI re-run is the
   verification gate (it re-checks the exact failing stage), so the disabled
   two-layer test runner (`verifyTwoLayer`) stays disabled — it was Java-specific
   and would mis-handle non-Java repos.

## Consequences

- Self-heal now covers static-analysis/Checkstyle in addition to unit tests.
- Blast radius is bounded by the MR diff + per-project serial scheduling; budget
  is shared across retries within one repair envelope.
- Human review remains mandatory; the bot never auto-merges. Production-code
  static-analysis findings still escalate when they fall outside the diff or
  need suppression to "pass".
- Spill files the bot writes into the worktree (CI log, MR diff) are stripped
  from the extracted patch so they never enter the diff-whitelist validation.
