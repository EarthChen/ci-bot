# 04 — Verification gate: dual-layer (related + full suite) + flaky @Skip

**What to build:** Thicken the verification gate from "related tests only" to dual-layer: first run the failed-test-related module for fast feedback, then (if green) run the full unit test suite as a regression backstop. When a flaky test is encountered during verification, mark it @Skip/@Disabled and send a separate DingTalk notification (NOT mixed into the fix MR) so reviewers aren't confused by unrelated flaky noise.

**Blocked by:** 02 (real pi agent — needs a real fix to verify)

**Status:** ready-for-agent

- [ ] Verification gate runs related test module first (fast feedback)
- [ ] If related green, run full unit test suite (regression backstop)
- [ ] Flaky test encountered during verification → mark @Skip/@Disabled in the test file
- [ ] Flaky notification sent via separate DingTalk message (decoupled from fix MR)
- [ ] Fix MR does NOT contain flaky @Skip changes (separate concern)
- [ ] End-to-end fixtures: verification all green → MR; verification hits flaky → @Skip + separate DingTalk, fix MR clean
