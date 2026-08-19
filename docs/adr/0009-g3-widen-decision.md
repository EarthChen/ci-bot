# G3 Widen Decision (diff-outside test/doc repair)

G3 rejects any patch touching files outside the MR diff. That gate is right for MR-induced failures — but it also kills a recurring real-world case: a **pre-existing failing test on master** (someone merged a code change without syncing the test, or merged a bug the test correctly reports). Every MR's pipeline trips over it; the agent diagnoses it (typically class 2), writes the fix, and G3 escalates because the test file is outside the triggering MR's diff — a dead end that wastes the whole run (observed: 48 turns / $2.59 for one such escalation) and leaves every MR blocked until a human fixes master by hand.

## Mechanism

1. **Widenability check** (`widenableG3Paths`, run-repair): a G3 violation is *widenable* iff the patch touches no build/CI config and every diff-outside path is widen-eligible (`isWidenEligiblePath`: contains a `src/test|it` segment, or is a doc file — `docs/`, `*.md|adoc|rst`). Anything else stays a dead-end escalation; src/main outside the diff is never widenable (the iron rule holds).
2. **Decidable escalation**: a widenable G3 violation is flagged `decidable` with the offending list as `oosPaths` — the existing T03 machinery then retains the scene and registers a decision. The decisions table gains `oos_paths TEXT` (additive migration at `DecisionStore` construction).
3. **Decision card**: the routed awaiting-decision message lists the exact files plus the `widen` option in the `/heal` template; cards without a list keep the plain `test|prod|drop` template.
4. **`/heal <id> widen`**: accepted only when the decision carries a list (rejected with usage otherwise). Claim-then-enqueue identical to `test`; the envelope carries `value: "widen"` + `oosPaths`.
5. **Resume with extended whitelist**: `runResumeRepair` widens the G3 whitelist to `MR diff ∪ oosPaths`, injects a widen-specific decision prompt (approved list = repair target; master-pre-existing tests; semantic changes must be declared item by item; everything outside the list remains forbidden), then reuses the standard post-fix pipeline (extractPatch → G3 → MR monitor/retry on the same MR). One-round intervention still applies.
6. **Audit**: the trace records `oosPaths`; the decision row records `decision_value=widen` + decider.

## Why a decision value, not a standing permission

- The fundamental uncertainty here is not diagnostic but **normative**: a failing test on master is either *stale* (code change intended, test should move — class 2 semantics) or *correct* (a real bug merged to master, and "fixing" the test cements the bug — the class-3 anti-pattern). The bot cannot tell them apart; a human must.
- A project-level standing permission ("always allow diff-outside tests") would silently make that call for every future case. Per-decision approval of a **frozen, enumerated list** keeps the human in the loop exactly where the judgment is required, and the list doubles as the audit trail of what was approved.
- The decision still grants nothing *beyond* the enumerated list — consistent with the decision-boundary rule (decisions resolve uncertainty, they don't grant open-ended privileges).

## Conservatism of the eligibility predicate

`isWidenEligiblePath` is deliberately stricter than `!isProductionPath`: the production-path heuristic anchors `^src/main/` at path start and cannot classify multi-module paths (`svc/src/main/...`) — precisely the shape of real Java monorepo patches. On an authorization boundary, unrecognizable paths are rejected, not assumed test/doc.

## Risks and mitigations

- **MR pollution**: the fix lands in the triggering MR, mixing an unrelated master-test repair into the author's changeset. Mitigation: explicit MR-body/diagnosis traceability and the human MR review gate (never auto-merge). Accepted residual: the alternative (a separate master-fix MR) needs master-pipeline handling the bot doesn't have (v1 is MR-triggered only).
- **Cementing a bug**: the human approver may misjudge stale-vs-correct. Mitigation: the decision card shows the diagnosis summary and the exact files; the widen prompt requires item-by-item declaration of assertion-semantic changes; MR review is the final backstop. Residual risk accepted — it is exactly the judgment the human is asked to make.
- **Widen-after-widen**: a resume that violates G3 again (new diff-outside files) is terminal — one-round intervention applies; no decision chaining.

## Consequences

- New `/heal` value `widen` (command-help.json, card templates, heal-command guard); decisions schema +1 nullable column (additive, migrates in place).
- The class-2-on-master failure mode becomes recoverable: diagnosis cost is preserved (scene + session retained) instead of discarded at the G3 gate.
- `RepairOutcome`/`RepairResult`/audit carry `oosPaths`; `ResumeDecision`/`ResumeContext`/`ResumeTask` envelopes carry `value: "widen"` + list.
