# Limited G3 Relaxation for Unit-Test Failures + Partial-Fix MRs

Unit-test failures may now modify `src/main` files **inside the MR diff**, under a hard rule: the change must make the implementation satisfy the existing failing tests, never the reverse. At the same time, an escalation that leaves validated partial progress now opens a partial-fix MR instead of abandoning the work in an ephemeral worker scene. Both changes were forced by the MR !281 (pipeline 100033426) real e2e run: the agent fixed 11 test files but had to escalate on 5 remaining failures whose root cause was the MR's own new `src/main` code violating its own spec (javadoc/ADR promises unimplemented) — previously a dead end that wasted the whole agent run and left the team nothing to review.

## Why limited, not full, relaxation

The danger is not `src/main` edits per se — it is the agent controlling **both sides of the test/code contract** simultaneously. A fully-permissioned agent can make CI green by letting tests and implementation converge on any self-consistent behavior, destroying CI's evidence value (worst case: silently picking one side of a genuine spec conflict and rewriting the other side's tests). The retained constraints:

- `src/main` edits only inside the MR diff — that code is the MR author's own in-flight work, not yet shipped to production; the blast radius of a wrong bot edit is bounded by the MR's own CI and human review. `src/main` outside the diff (shipped production code) stays absolutely forbidden.
- The agent must satisfy the **existing** failing tests; rewriting their assertion semantics is forbidden (compile-adaptation edits excepted), and every semantic test change must be itemized in the MR description.
- Human review at merge time remains the final gate (auto-merge stays forbidden). This converts the human role from "decide + fix via /heal" to "confirm at MR review" — reduced, not removed. Spec conflicts with no test to lean on still escalate.

This amends ADR-0005's statement that resumed unit-test runs may never touch `src/main`.

## Partial-fix MRs

Escalations with validated partial progress now commit + push + open an MR (title prefix `(部分修复)`, normal MR, not draft) whose description states what is fixed, what still fails and why, and what the human must do; the escalated result carries `mrUrl` into the routed notification, the audit trace, and the decision context. A later `/heal` resume continues on the same branch/MR. Partial MRs are exempt from the bot's MR-CI monitor/retry loop — they are red by definition until the human acts. Enabling facts from the same e2e: `parseDiffFiles` previously understood only `diff --git` headers while glab emits plain `---/+++` unified diffs, silently disabling the G0 diff whitelist in production; it now parses both. Bot-created MRs default `--remove-source-branch=true --squash-before-merge=true`.

## Consequences

- `validatePatchPaths` semantics are unchanged (diff membership + forbidden configs); the relaxation lives in what the diff whitelist now permits agents to attempt, enforced agent-side by the playbook and bot-side by the same G0 gate (which now actually functions on real diffs).
- Wrong-side risk shifts to MR review: reviewers must read the declared test-semantic changes; the MR description contract is now load-bearing.
- GitLab accumulates partial-fix branches/MRs for escalations that previously left no artifact; `remove-source-branch` keeps them from piling up after merge.
- See commits: class-5 early-filter split, worktree refspec/self-heal fixes, maxBuffer fix (same e2e series).
