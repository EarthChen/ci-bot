# 02 — Real pi agent + class 1 (test bug) repair

**What to build:** Replace the stub agent runner with a real pi SDK `createAgentSession`. The agent loads the java-coding-standards skill via `/skill:name` (deterministic loading) with a prompt that explicitly names the skill, diagnoses a G1 class 1 failure (wrong assertion / mock / data — test-layer bug), edits the test file, runs the related tests, and outputs a structured result (success/handoff). MR carries a real diff. Budget soft-limit (turn_end + session.abort) wired. No class 2/3/4/5, no doc sync, no full-suite regression, no flaky handling, no concurrency.

**Blocked by:** 01 (tracer bullet pipeline)

**Status:** ready-for-agent

- [ ] pi SDK `createAgentSession` wired into agent runner (TS same-process import)
- [ ] `/skill:name` loads java-coding-standards deterministically; prompt also names the skill (dual guarantee)
- [ ] Budget soft-limit: turn_end event listener + token accumulator + session.abort() on threshold + DingTalk alert on overrun
- [ ] Agent diagnoses class 1 (test bug) from CI logs + diff + source, edits test file only (src/main write banned)
- [ ] Agent outputs structured result (success / handoff / diagnosis-summary) at session end; bot code reads it
- [ ] Verification runs related tests only (full-suite backstop is ticket 04)
- [ ] MR opened with real fix diff + summary; DingTalk success on green, handoff on stuck
- [ ] End-to-end test fixture: class 1 webhook → MR with test-only diff → DingTalk success
