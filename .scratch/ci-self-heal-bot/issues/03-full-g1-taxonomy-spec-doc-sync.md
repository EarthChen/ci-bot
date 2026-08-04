# 03 — Full G1 taxonomy (1/2/3 repair, 4/5 handoff) + spec read + doc sync

**What to build:** Extend the agent's diagnosis to all five G1 root-cause classes. Class 2 (tested-code change made test stale): update expectations/mock + light test refactor + sync related spec paragraphs when behavior changed. Class 3 (test missing): read in-repo spec/PRD, add spec-conformance test for the failed path only (narrow→wide); if code behavior ≠ spec or spec unreadable → handoff. Class 4 (flaky/environment): handoff, no fix. Class 5 (non-unit-test root cause: compile/dependency): bot code coarse-filters by keyword before spawning agent, early handoff saving budget. Spec read during diagnosis (class 3), spec write during post-fix (class 2 behavior change) — timing naturally separated in the pipeline.

**Blocked by:** 02 (real pi agent + class 1)

**Status:** ready-for-agent

- [ ] Agent classifies failures into all 5 G1 classes (not just class 1)
- [ ] Class 2: update assertions/expectations/mock + light test structure refactor (split oversized methods, fix mock placement); sync only directly-related spec paragraphs (API desc/params/return semantics) on behavior change
- [ ] Class 3: read in-repo spec directory (e.g. docs/spec/), add spec-conformance test asserting correct behavior per spec (NOT current code behavior); only failed-path-related scope
- [ ] Class 3 boundary: code behavior ≠ spec → handoff; spec unreadable/absent → handoff
- [ ] Class 4: handoff, no fix, DingTalk notify
- [ ] Class 5: bot code keyword coarse-filter (compile error / dependency resolution) before agent spawn → early handoff + DingTalk (saves budget)
- [ ] Spec read/write timing: diagnosis stage reads spec (class 3), post-fix stage writes spec (class 2 behavior change)
- [ ] Permission boundary enforced: only test/docs written, src/main banned; production-code bug discovered → handoff
- [ ] End-to-end fixtures: class 2 (stale+behavior change → test+spec sync), class 3 (spec readable → conformance test), class 3 (spec unreadable → handoff), class 3 (code≠spec → handoff), class 4 (flaky → handoff), class 5 (compile error → early handoff no agent spawn)
