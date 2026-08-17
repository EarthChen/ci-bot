# Escalation Scene Retention and Human-Decision-Driven Session Resume

When the CI repair agent escalates with a diagnosis but cannot determine whether the root cause is a test defect or a production code defect, the bot now retains the worker's scene (cwd, worktree, session, branch) and awaits a structured human decision (`/heal <id> test|prod|drop`) before resuming or closing. Previously all escalations destroyed the scene immediately, discarding accumulated diagnostic context and forcing humans to restart from scratch. This shift from per-event ephemeral workers to mixed-lifecycle workers (some retained, most still ephemeral) is hard to reverse, surprising without context ("why do some escalations not delete cwd?"), and trades disk usage for recoverability — accepted because the alternative is unbounded human rework cost.

## Relationship to ADR-0004 Session-Reuse Retry

ADR-0004's session-reuse retry keeps the agent session **alive inside one worker subprocess**: when the MR's head pipeline turns red, that same worker injects the fresh CI log and re-runs. This ADR (0005) introduces the complementary **cross-process resume**: the original worker exits, the scene is freeze-dried to disk, and a **new worker** re-opens the persisted session file after a human decision to continue the repair pipeline. The two cover different lifecycle moments (post-MR CI re-runs vs pre-MR human decision blocking) and do not replace each other. Per ADR-0004, G3 unit-test rules are unchanged: a resumed run for a unit-test failure may still only touch `src/test|it`/`docs`, never `src/main`.

## Consequences

- Workers now have two lifecycles: ephemeral (class-5 early-screen, bot failures, successful repairs) and retained (agent-initiated decidable escalations). Cleanup logic must distinguish them.
- A new SQLite-backed `DecisionStore` becomes part of the critical path; its schema and TTL sweep are operational concerns absent before.
- The one-round intervention limit (second escalation = terminal) caps human-in-the-loop cost but means some ambiguous cases will still end up fully manual.
- Notification routing changes: escalated notifications now flow through `ProjectRouter` in the main process rather than being sent directly by workers, centralizing routing state.
- See spec: `.scratch/human-decision-resume/spec.md`.
