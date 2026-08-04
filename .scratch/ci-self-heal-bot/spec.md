# Spec: CI 单测自愈 Bot

> Status: ready-for-agent
> Feature: ci-self-heal-bot
> Source: wayfinder/MAP.md + 9 decision tickets (R1–R4, G1–G7) + 4 research briefs

## Problem Statement

CI 单元测试失败后，开发者必须手动介入：判断失败根因、修复测试 bug、补全缺失测试、在被测代码变更后更新测试期望、在行为变更时同步文档。这些工作繁琐、重复、跨多项目不可扩展。尤其在大规模 Java/Spring 项目中，一个 pipeline 可能有多个单测 job 同时失败，开发者疲于逐个 triage，而很多失败其实是测试层的简单问题（断言写错、mock 过时、新代码路径没覆盖），不需要动生产代码。

## Solution

一个 headless 长驻 bot 服务，监听 GitLab pipeline 失败 webhook，用 AI agent（pi SDK + 已有语言 skill）自动诊断单测失败根因、修复/补全测试（绝不碰生产代码）、在被测代码行为变更时顺带同步文档、开 MR 供人工 review、通过钉钉主动推送结果。v1 只处理单测失败，按"窄→宽"迭代——lint/build/typecheck/integration 是后续扩展。bot 以 pi 为核心 SDK（TypeScript 实现），演进接缝标明切回 Claude SDK 的路径。

## User Stories

### 触发与接入

1. As a developer, I want the bot to automatically detect when my GitLab pipeline's unit tests fail, so that I don't have to manually triage every failure.
2. As a project maintainer, I want to configure which GitLab projects/repos the bot watches, so that only relevant projects trigger fixes.
3. As a DevOps engineer, I want the bot to listen to GitLab pipeline-event webhooks (not job-level), so that one pipeline triggers exactly once and multi-job failures aggregate into one fix.
4. As a DevOps engineer, I want the bot to verify webhook signatures (GitLab `X-Gitlab-Token`), so that forged requests can't trigger fixes.
5. As a DevOps engineer, I want the bot to apply IP allowlists (GitLab egress IPs) and rate limiting, so that the webhook endpoint isn't abused.
6. As a DevOps engineer, I want the bot to deduplicate events by pipeline id, so that GitLab's webhook retries don't cause duplicate work.
7. As a DevOps engineer, I want the bot to accept pipeline-terminal latency (failed state), so that the trigger mechanism stays simple even if some stages finish late.

### 并发与调度

8. As a DevOps engineer, I want the bot to spawn workers on-demand (event → spawn → run → exit), so that idle resources aren't consumed.
9. As a DevOps engineer, I want the bot to enforce a global concurrency cap N with overflow queueing (no drop), so that resources don't exhaust under load spikes.
10. As a DevOps engineer, I want per-project serial queues, so that one project's failures don't block another project's.
11. As a DevOps engineer, I want the bot to handle cross-pipeline expiry (new push supersedes old), so that it doesn't waste effort on stale commits.
12. As a developer, I want stale-commit fix MRs to be marked "rebase or discard", so that reviewers aren't confused by outdated fixes.
13. As a developer, I want the bot to DingTalk-notify me when a fix is superseded by a newer push, so that I know the old fix is stale.

### 诊断与分类

14. As a developer, I want the bot to classify my test failure by root cause, so that it only auto-fixes when the root cause is in the test layer.
15. As a developer, I want the bot to skip compilation/dependency errors early (class 5), so that it doesn't waste effort on non-test failures.
16. As a developer, I want the bot to skip flaky/environment failures (class 4), so that it doesn't chase non-deterministic issues.
17. As a developer, I want the bot to read the in-repo spec/PRD when supplementing missing tests (class 3), so that new tests assert correct behavior per spec (not current code behavior, avoiding cementing bugs).
18. As a developer, I want the bot to hand off to me when code behavior doesn't match spec, so that potential production bugs get human attention.
19. As a developer, I want the bot to hand off to me when the spec is unreadable or absent, so that spec-compliance tests aren't guessed.
20. As a developer, I want the bot to use both CI log signals and local execution signals for classification, so that root-cause judgment is more accurate than log-only.

### 修复

21. As a developer, I want the bot to fix test bugs (wrong assertions/mock/data, class 1), so that I don't spend time on trivial test fixes.
22. As a developer, I want the bot to update stale test expectations when production code changes (class 2), so that tests stay in sync with code.
23. As a developer, I want the bot to add missing tests for uncovered code paths (class 3), so that coverage improves without manual effort.
24. As a developer, I want the bot to ONLY modify test files and documentation, so that production code is never touched by the bot.
25. As a developer, I want the bot to hand off to me when it discovers a production-code bug, so that the root cause (which may be outside this service) gets human attention.
26. As a developer, I want the bot to do light test structure refactoring (split oversized methods, fix mock placement) when needed, so that structural test bugs are also fixable.
27. As a developer, I want the bot to limit refactoring scope, so that diffs stay reviewable.
28. As a developer, I want the bot to only supplement tests for the failed-path-related scope (narrow→wide), so that the MR doesn't balloon into a coverage overhaul.

### 文档同步

29. As a developer, I want the bot to sync documentation when a code change alters behavior (class 2), so that docs stay consistent with code.
30. As a developer, I want doc sync to only touch directly-related paragraphs (API description, parameters, return semantics), so that the diff is minimal and focused.
31. As a developer, I want the bot to read spec during diagnosis (class 3) and write spec during post-fix (class 2 behavior change), so that spec serves as both input and output with naturally separated timing.

### 验证

32. As a developer, I want the bot to run the related tests after fixing, so that the fix is verified before opening an MR.
33. As a developer, I want the bot to run the full unit test suite as a regression backstop, so that the fix doesn't break other tests.
34. As a developer, I want the bot to mark flaky tests as @Skip/@Disabled when encountered during verification, so that they don't block the fix MR.
35. As a developer, I want the bot to DingTalk-notify me separately about flaky tests, so that they don't pollute the fix MR's review.

### MR 与通知

36. As a developer, I want the bot to open an MR with a fix summary, so that I can review and merge.
37. As a developer, I want the bot to mark incomplete fixes (stuck / max-turns-reached) in the MR, so that I can pick up where the bot left off.
38. As a developer, I want the bot to include a diagnosis summary in handoff MRs, so that I understand why it couldn't fix.
39. As a developer, I want the bot to send DingTalk notifications for fix success / handoff / exception, so that I'm always informed without checking MRs.
40. As a developer, I want DingTalk notifications to be decoupled from MRs, so that I get notified even when no MR is opened (e.g., class 4/5 handoff).
41. As a project maintainer, I want human review to be mandatory before merge, so that the bot never auto-merges.
42. As a developer, I want the bot to directly hand off when it can't fix (no multi-retry), so that it doesn't burn budget on hopeless cases.

### 安全

43. As a DevOps engineer, I want the bot to isolate each worker's directory, session, and config (PI_CODING_AGENT_DIR + --session-dir + cwd), so that concurrent workers don't leak state.
44. As a security engineer, I want the bot to store secrets in .env (chmod 600, gitignored, never committed), so that credentials aren't exposed.
45. As a security engineer, I want the bot to only write to test/docs directories, so that production source code is protected.
46. As a security engineer, I want the bot to reuse .m2 read-only, so that Maven cache is shared without write contamination.
47. As a security engineer, I want the bot to archive all diffs and LLM reasoning traces, so that bad fixes can be traced post-hoc.
48. As a security engineer, I want the bot to pin dependency versions and run pnpm audit, so that supply-chain attacks are mitigated.
49. As a security engineer, I want the bot to run under a restricted OS user (v1) or container non-root user (docker evolution), so that FS access is narrowed.

### 可观测性与运维

50. As a DevOps engineer, I want structured JSON logs and lightweight metrics (SQLite/file), so that I can monitor without external dependencies.
51. As a DevOps engineer, I want per-fix traces (project / failure-class / turns / tokens / cost / result / MR-link), so that I can audit individual fixes.
52. As a DevOps engineer, I want DingTalk alerts for bot self-failures (webhook down, workers dead, quota exhausted), so that I'm proactively notified.
53. As a DevOps engineer, I want a cost estimate formula, so that I can budget before empirical data is available.
54. As a DevOps engineer, I want the bot deployed as a single-process TS service with on-demand worker subprocesses (v1 local, docker evolution), so that deployment is simple and doesn't require k8s.

### 演进

55. As an architect, I want the spec to document evolution seams (split subagent, switch SDK, docker deploy, container isolation), so that future growth paths are clear.
56. As an architect, I want the bot to switch from pi to Claude SDK if budget soft-limits prove insufficient, so that hard cost caps can be reclaimed.
57. As an architect, I want the bot to split into subagents (pi-subagents extension) when context pressure or multi-module failures exceed single-agent capacity, so that diagnosis/repair quality doesn't degrade at scale.
58. As an architect, I want the bot to add container/microVM isolation if prompt-injection threats escalate, so that LLM-generated test code can't escape the worker boundary.

## Implementation Decisions

### SDK 与语言

- **Core SDK**: pi (v1). TypeScript implementation. pi provides `createAgentSession` (Node.js SDK) for headless agent invocation. Rationale: pi's `/skill:name` deterministic command loading directly mitigates the headless "model didn't read skill" risk (vs Claude SDK's LLM semantic-match non-determinism); pi skills are zero-migration (existing java-coding-standards/springboot-tdd reused as-is); pi has full native model coverage (DeepSeek/Kimi/OpenRouter→Qwen/Bedrock/Vertex/Ollama/vLLM) without protocol-conversion proxies.
- **SDK swappability**: spec writes pi(TS) concrete design. Evolution seam: if pi's self-built budget soft-limit overruns frequently, switch back to Claude SDK to reclaim native `max_budget_usd` hard cap. Switch-back cost: language/MCP/notification/pipeline are zero (all SDK-agnostic); max cost is skill expression paradigm conversion (pi `/skill:name` deterministic → Claude AgentDefinition prompt + LLM semantic match); budget control is a gain.
- **MCP form**: external service (stdio subprocess or HTTP remote). MCP protocol is language-agnostic; the bot (TS) can call any-language MCP server. No in-process MCP server. Agent holds NO DingTalk MCP tool.
- **Language**: TypeScript. All mainstream SDKs (pi / Claude / Codex) have TS versions; TS is the cross-SDK greatest common denominator. Node dependency management uses pnpm.

### Agent 编排 (v1: single agent)

- v1 uses a single main agent + skills enabled + `/skill:name` deterministic loading. The agent runs one continuous session per fix (diagnose → fix → sync docs → output structured result). Diagnosis conclusions stay in-context (no cross-model drift). No subagent routing in v1.
- **Skill loading**: prompt explicitly names language skills ("处理 Java 单测失败时先读 java-coding-standards") AND `/skill:name` command forces deterministic load (dual guarantee). Existing pi skills (java-coding-standards, springboot-tdd, springboot-patterns, python-patterns) are reused with zero migration.
- **Structured result output**: at session end, agent outputs a structured result (success / handoff / flaky / diagnosis-summary). Bot code reads this result and executes downstream actions (open MR / notify DingTalk). Agent does NOT call DingTalk directly.
- **Evolution seam (split subagent)**: trigger = context pressure exceeds threshold / failure involves multi-module / diagnosis-repair capability gap too large for single model. Mechanism: use pi-subagents extension (per-agent model + skills + independent context); diagnosis/repair/doc segments move to subagents; diagnosis conclusion passed as structured input to repair subagent; skill still uses `/skill:name` within subagent scope.

### 模型与 Provider

- **v1 model strategy**: single main model (multi-model routing deferred to evolution).
- **Provider**: direct connect via pi native provider config (models.json declarative + env interpolation + InMemoryCredentialStore). Candidates: DeepSeek, Kimi (For Coding), OpenRouter (routes to Qwen), Ollama (local). No proxy layer. Each provider independently configured; switching is code change not config.
- **Fallback chain**: primary → same-family backup → human handoff. No cross-family degradation (avoids behavior inconsistency). Same-family backup may fail simultaneously (same provider outage), but cross-family cost jump and behavior drift risk is worse.
- **Budget control**: dual-layer. (1) subagent `max_turns` (anti-loop, pi-subagents supports). (2) Global budget (anti-runaway, pi self-built): SDK listens to `turn_end` event + accumulates tokens + calls `session.abort()` on threshold exceed + DingTalk alert. **Soft-limit risk**: abort fires after turn ends; single turn may already overrun (e.g., large tool call). Mitigation: aggressive per-turn token threshold + abort + DingTalk alert. Evolution seam: overruns frequent → switch to Claude SDK hard cap.

### 失败分类法 (G1)

5-class root-cause taxonomy. v1 only auto-fixes classes 1/2/3; 4/5 transfer to human.

| Class | Root cause | v1 action |
|-------|-----------|-----------|
| 1 | Test bug (wrong assertion/mock/data) | Fix test |
| 2 | Code change made test stale | Update test expectation/mock; if behavior changed, sync docs |
| 3 | Test missing | Add spec-compliance test per spec/PRD (NOT "make code pass") |
| 4 | Environment / flaky | Handoff, no fix |
| 5 | Non-unit-test root cause (compile/dependency) | Handoff, out of scope |

- **Principle**: if root cause possibly outside this service, never auto-fix.
- **Judgment signals**: CI log summary + local execution (dual-source, not webhook-only).
- **Class 5 early-filter**: bot code coarse-filters by keywords (compile error / dependency resolution) before spawning agent, saving budget.
- **Class 3 spec-conformance**: tests assert "correct behavior per spec" not "behavior code currently exhibits" (avoids cementing bugs). Spec location: in-repo spec directory (e.g., docs/spec/, specs/, docs/adr/). If code behavior ≠ spec → handoff. If spec unreadable/absent → handoff.
- **Class 4 vs 5 separation**: class 5 early-transfer (CI log determinable, saves budget); class 4 late-transfer (identified after local reproduction/history analysis).

### 修复策略 (G3)

- **Permission boundary**: ONLY touch tests and docs, NEVER production code (src/main). If production-code bug discovered → handoff.
- **Class 1/2 (test bug / stale)**: change assertions/expectations/mock values + light test structure refactor (split oversized methods, fix mock placement). Evolution seam: if refactor introduces new bugs frequently, revert to assertions-only.
- **Class 3 (test missing)**: add spec-compliance test per spec/PRD, only for failed-path-related scope (narrow→wide).
- **Class 2 doc sync**: only change directly-related paragraphs (API description, parameters, return semantics). No full rewrite, no unrelated paragraphs.
- **Review strength**: mandatory human review (no auto-merge).

### Pipeline 编排 (G2)

```
GitLab webhook (pipeline failed)
  → bot: signature verify + IP allowlist + rate limit + pipeline-id dedup
  → bot: global queue (concurrency cap N, per-project serial)
  → bot: spawn worker (per-worker PI_CODING_AGENT_DIR + --session-dir + cwd)
  → bot: glab fetch CI logs + MR diff + pipeline status
  → bot: coarse-filter class 5 (keyword)? → early handoff + DingTalk
  → bot: local clone + restricted user + .m2 read-only mount
  → bot: start pi agent session (createAgentSession, budget soft-limit set)
  → agent: read CI logs + diff + source, classify (G1 1/2/3)
      ├─ class 4 flaky/env → handoff, no fix + DingTalk
      └─ class 1/2/3 → read spec (class 3) + fix/supplement tests
          (/skill:name loads java-coding-standards; prompt names skill)
          → behavior changed? → sync spec/docs
  → bot: verification gate (related tests fast feedback + full suite backstop)
      ├─ all green → open MR with fix summary + DingTalk success
      ├─ flaky encountered → mark @Skip/@Disabled + separate DingTalk (not in fix MR)
      └─ stuck / max-turns → handoff, MR with incomplete marker + diagnosis summary + DingTalk
```

- **Channel**: hybrid — glab for structured metadata (CI logs, MR diff, pipeline status; fast judgment), local clone+exec for reproduction/source/spec/blame/test-run (deep diagnosis). Two auth: GitLab token injected into worker via .env.
- **Notification path**: pure bot code calls DingTalk at deterministic pipeline nodes (fix success / handoff / verification flaky / bot self-failure). Agent outputs structured result only; holds NO DingTalk MCP tool. Rationale: headless terminal notifications must be deterministic (R2 confirmed LLM-semantic-match is non-deterministic).

### 并发模型 (G4)

- **Worker supply**: on-demand spawn (event → spawn worker running G2 pipeline → exit). Zero idle cost.
- **Trigger source**: Pipeline event (not job). One pipeline fires once; same-pipeline multi-job failures naturally aggregate into one fix (no dedup/merge logic).
- **Cross-pipeline expiry**: serial queue per project. Worker finishes current pipeline, then takes latest from queue. Stale-commit MR marked "rebase or discard" + DingTalk notify. No interrupt (doesn't waste consumed turns). Cross-commit events NOT merged (each independent, serial).
- **Isolation**: per-worker independent `PI_CODING_AGENT_DIR` + `--session-dir` + `cwd` (pi shared-state isolation). Bot-code layer, not SDK default.
- **Backpressure**: global concurrency cap N + overflow FIFO queue (no drop). Queue too long → DingTalk alert (human can intervene). N value depends on deploy machine resources (TBD empirically).

### 沙箱与安全 (G5)

- **Sandbox**: directory isolation + restricted OS user, NO container (v1). Threat model B: internal trusted projects, LLM produces errors not malicious. Evolution seam: threat upgrade to A (prompt injection materializes) → add container/microVM.
- **Secrets**: .env preferred + env vars. GitLab token, model API key, MCP auth stored in .env (chmod 600, .gitignore, never committed). Bot reads .env, doesn't persist secrets.
- **LLM audit**: full archive of diff + MR description + LLM reasoning traces (diagnosis conclusion, root cause, repair rationale) to log/object storage. Bad fixes traceable post-hoc.
- **Supply chain**: version pin + pnpm-lock + pnpm audit. MCP server sources limited to official/trusted.
- **Write permission (G3)**: test/docs only, src/main banned.
- **Permission matrix**:

| Object | Read | Write | Notes |
|--------|------|-------|-------|
| Project checkout | ✅ | ✅ (test/docs dirs) | G3 bans src write |
| Spec directory | ✅ | ✅ (class 2 behavior change) | G1 decided |
| .m2 | ✅ | ❌ | Read-only reuse |
| ~/.ssh, ~/.aws etc | ❌ | ❌ | Restricted user + chmod |
| .env (secrets) | ✅ | ❌ | chmod 600 + .gitignore |

- **Evolution seam (docker)**: bot service docker deployment. Worker = in-container fork/exec (NOT docker-in-docker/DooD). G5 restricted user → container non-root user (Dockerfile `USER`). Directory isolation + chmod unchanged. .m2 via volume read-only mount. `PI_CODING_AGENT_DIR` points to container-internal config. Further evolution to per-worker container (DooD) requires reopening G5.

### 部署与运维 (G7)

- **Runtime (v1)**: local directory deployment. Single-process bot (TS) + on-demand spawn worker subprocess. Host preinstalls Node + pnpm + JDK + Maven. No container, no k8s.
- **GitLab webhook**: public HTTPS endpoint + signature verify (`X-Gitlab-Token`) + IP allowlist (GitLab egress IPs) + rate limit. Pipeline-id idempotent dedup. GitLab webhook default retries 4×; bot long-down loses events (best-effort self-heal, non-critical path, lost event = no fix, human can retrigger).
- **Observability**: structured JSON logs + lightweight metrics (SQLite/file, no external deps). Per-fix trace: project / failure-class / turns / tokens / cost / result / MR-link. Metrics: success rate / average fix duration / cost/fix. Evolution seam: Prometheus + Grafana.
- **Alerting**: DingTalk unified (extends G2 fix-result channel). Bot self-failures (webhook down / workers dead / quota exhausted) also DingTalk. Evolution seam: multi-channel (DingTalk + email).
- **Cost estimate**: formula + magnitude, values TBD empirically. Single fix: 5k–20k tokens (diagnosis + repair + docs, depends on failure complexity + diff/source/log volume). Monthly peak: `N × daily-fixes × tokens × unit-price × 30`. `max_budget_usd` soft-limit cap per fix (pi self-built).

### 模块清单

- **Webhook receiver** — GitLab pipeline event intake, signature verification, IP allowlist, rate limit, pipeline-id idempotent dedup.
- **Event queue & scheduler** — global FIFO queue, concurrency cap N, per-project serial queue, cross-pipeline expiry (take latest).
- **Worker supervisor** — on-demand spawn worker subprocess (TS), per-worker isolation config (PI_CODING_AGENT_DIR + --session-dir + cwd), worker lifecycle (spawn → run → exit), resource limits.
- **GitLab client** — glab CLI wrapper: CI logs, MR diff, pipeline status, MR creation; GitLab token from .env.
- **Agent runner** — pi SDK `createAgentSession`, skill loading (`/skill:name`), prompt with language skill naming, budget control (turn_end + abort soft limit), structured result output.
- **Diagnosis classifier** — G1 5-class taxonomy; bot code coarse-filters class 5 (keyword); agent deep-classifies 1–4.
- **Repair executor** — G3 playbook: class 1/2 test fix (assertions/mock + light refactor), class 3 spec-compliance test, class 2 doc sync (related paragraphs only); NEVER production code.
- **Verification gate** — related tests fast feedback + full suite regression; flaky → @Skip/@Disabled + separate DingTalk.
- **MR creator** — glab MR creation with fix summary / handoff marker + diagnosis summary.
- **Notification service** — DingTalk SDK, deterministic nodes (fix success / handoff / flaky / bot self-failure); agent holds NO DingTalk tool.
- **Observability** — structured JSON logs, SQLite metrics store, per-fix trace.
- **Config loader** — project-level config (GitLab repo/token/model preference), .env secret loading.
- **Audit archive** — diff + LLM reasoning traces persistence.

## Testing Decisions

### Testing seam

**Single end-to-end seam**: GitLab webhook endpoint → MR creation / handoff / DingTalk notification (black box).

This is the highest possible seam — above it is GitLab (we can't test), below it are internal details (SDK calls, skill triggers, worker state) that are fragile to test and not what the user/reviewer cares about.

### What makes a good test

- Test **external behavior** (MR diff correctness, notification delivery, handoff appropriateness), NOT implementation details (how Claude SDK / pi is called internally, whether skill was triggered, worker subprocess state).
- A test must encode WHY the behavior matters, not just WHAT happens. E.g., "class 3 supplement test must assert spec behavior not current code behavior" tests the anti-bug-cementing intent, not just "a test was added."
- Tests use **fixtures** for the agent (pi `createAgentSession` stubbed to return canned diagnosis + fix diff) and GitLab API (glab calls intercepted to verify arguments, no real MR opened).

### Test matrix (fixture-driven, single seam)

| Given (webhook fixture) | Expected (external behavior) |
|---|---|
| Class 1 (test bug) | MR opened, diff only touches test files, DingTalk success notification sent |
| Class 2 (stale + behavior change) | MR touches tests + syncs related spec paragraphs |
| Class 3 (test missing, spec readable) | MR adds spec-conformance test for failed path |
| Class 3 (spec unreadable) | Handoff, DingTalk notify, no MR |
| Class 3 (code ≠ spec) | Handoff, DingTalk notify |
| Class 4 (flaky/env) | Handoff (no fix), DingTalk notify, no MR |
| Class 5 (compile error) | Early handoff (no agent spawn), DingTalk notify |
| Same pipeline retried | Only one fix triggered (pipeline-id idempotent) |
| Pipeline B arrives while A running | A finishes, then B taken; A's MR marked stale |
| Concurrency at cap N | Event queued, not dropped |
| Agent stuck / max-turns | Handoff MR with incomplete marker + diagnosis summary, DingTalk |
| Verification hits flaky | @Skip/@Disabled marked + separate DingTalk, not in fix MR |
| Invalid webhook signature | Rejected (401/403), no processing |
| Bot self-failure (webhook down) | DingTalk alert on recovery |

### What is NOT tested at this seam (implementation details)

- pi SDK internal `createAgentSession` call mechanics.
- Skill trigger mechanism (R2 confirmed non-deterministic; testing it is fragile).
- Worker subprocess internal state.
- Prompt execution (whether model "read" the skill — backstopped by verification gate + MR review).

### Prior art

Greenfield repo — no existing test patterns to follow. The single-seam approach is chosen to minimize test surface; if implementation reveals a complex internal module (e.g., G1 classification logic) that needs isolated testing, prefer covering it via different fixtures at the end-to-end seam before sinking a new seam. Only sink a new seam if the end-to-end test is too slow or can't exercise the branch.

## Out of Scope

- **Bot implementation (destination form A)**: this spec is the design document; turning it into a running system is the next effort.
- **Non-unit-test CI failures** (lint / build / typecheck / integration / e2e): v1 only handles unit test failures; per user "narrow→wide" preference, these are later expansion.
- **Auto-merge MRs**: user chose mandatory human review.
- **Proactive coverage patrol**: user chose passive (only on CI failure; no coverage-signal triggers).
- **Multi-CI platform abstraction**: v1 only GitLab CI; GitHub Actions etc. are later expansion.
- **Proactive doc consistency checks / semantic diffing**: user chose passive (only on behavior change during a fix).
- **Per-worker container isolation (DooD)**: v1 uses directory isolation; DooD requires reopening G5.
- **Multi-model routing**: v1 uses single main model; multi-model subagent routing is an evolution goal.

## Further Notes

### Evolution seams (spec documents, not defers vaguely)

1. **Split subagent**: trigger = context pressure / multi-module failure / capability gap. Mechanism = pi-subagents extension (per-agent model + skills + independent context). Diagnosis/repair/doc segments move to subagents; diagnosis conclusion as structured input to repair subagent; skill still uses `/skill:name` in subagent scope.
2. **Switch SDK**: trigger = pi budget soft-limit overruns frequent (single-turn overrun uncontrollable). Mechanism = switch to Claude SDK (TS same-process import). Replacements: `/skill:name` → AgentDefinition prompt (deterministic → non-deterministic, accept degradation); zero-migration skill → restructure to subagent prompt; MCP external service unchanged; language/pipeline unchanged; budget control gain (native max_budget_usd hard cap).
3. **Docker deployment**: trigger = deployment standardization / portability needed. Mechanism = bot service dockerized; worker = in-container fork/exec (non-DooD); G5 restricted user → container non-root user; .m2 via volume read-only mount.
4. **Container/microVM isolation**: trigger = prompt-injection threat escalates (threat model A). Mechanism = add gVisor/Firecracker/standalone container for worker execution isolation (R1: layer-7 not enough, need kernel-level).
5. **Refactor scope收紧**: trigger = LLM test refactoring introduces new bugs frequently. Mechanism = revert class 1/2 from "light refactor" to "assertions/expectations/mock-only."

### Empirical verification items (written into spec, TBD during implementation)

- pi self-built budget control (turn_end + abort) actual braking effect on single-turn overrun.
- pi-subagents extension per-agent model override + skills stability under headless concurrency.
- `/skill:name` reliable expansion in RPC/SDK `prompt()` (R4 gap).
- pi same-process multi-AgentSession concurrency event-bus isolation (R4 gap).
- stdio MCP token via env (pi has no built-in MCP; extension OAuth path).
- DeepSeek thinking mode + tool calls multi-turn `reasoning_content` must round-trip (#1378, cross-SDK).
- glab CI log / MR diff API rate limiting and retry strategy.
- Local clone large repo shallow depth vs git blame compatibility (blame needs history).
