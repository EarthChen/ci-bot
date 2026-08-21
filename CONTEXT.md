# CI Self-Heal Bot

This context defines the ownership and runtime language for the CI unit-test self-healing bot.

## Agent Runtime

**Bot-owned Pi configuration**:
The Pi settings, playbook, and model-candidate policy shipped with the self-heal bot. It is the only configuration allowed to shape an agent worker.
_Avoid_: target-project Pi configuration, user-global Pi configuration

**Data root**:
The single writable directory the bot owns, from which the per-event working area, the shared bare-clone cache, durable audit traces, and logs all derive. It is distinct from the bot-owned configuration root (read-only resources) and from the Pi credential root (secrets). Centralizing writable state under one root makes retention, cleanup, and volume mounting a single operational concern rather than four.
_Avoid_: scattering writable paths across independent environment variables, mixing writable data into the read-only configuration root.

**Target worktree**:
The checked-out project revision in which the agent diagnoses a failed pipeline and prepares a test/documentation-only change.
_Avoid_: agent configuration directory, bot workspace

**Model candidate**:
An ordered provider and concrete model pair, with a reference to the deployment secret that authenticates it.
_Avoid_: provider-only fallback, implicit default model

**Provider selection**:
The deterministic startup choice of the first usable same-family model candidate. A running repair keeps its selected provider; runtime provider errors are escalated rather than mixed with another session.
_Avoid_: cross-family fallback, mid-session model switching

**Model profile**:
A runtime-owned, Pi-compatible settings subset bound to a model candidate. It controls thinking and compaction policy but never redeclares model catalog facts such as context-window or maximum-output size.
_Avoid_: model metadata override, vertical-agent profile

**Model policy**:
A named, runtime-owned selection of approved model candidates and profiles that a vertical agent may request. It does not expose provider credentials, direct provider/model selection, or raw token-budget configuration to the vertical agent.
_Avoid_: vertical agent provider selection, embedded API key

**Agent capability**:
A platform-owned, reviewed operation exposed by the shared agent runtime. It defines what an agent may do independently of any prompt or skill.
_Avoid_: capability implied by a prompt, arbitrary shell authority

**Capability profile**:
A named, platform-owned allowlist of built-in Pi tool capabilities that a vertical agent may request. The runtime grants the profile; a vertical agent cannot create arbitrary execution authority through its resources. The first version is a fixed configuration allowlist, not a custom-tool plugin mechanism.
_Avoid_: arbitrary tool declarations in a vertical agent, speculative plugin framework

**Agent resources**:
A vertical agent's prompt, append-only system prompt, skills, and optional result contract. Resources instruct an agent but do not grant execution authority. The system instruction augments Pi's default system prompt; it never replaces it.
_Avoid_: treating a skill or prompt as a capability, replacing Pi's default system prompt

**Agent artifact**:
The authoritative observable effect of an agent run, such as a workspace `git diff`, a generated file, a tool result, or a validated structured result. Free-text assistant output is advisory unless a vertical agent explicitly declares a result contract.
_Avoid_: treating a narrative summary as evidence of a completed code change

**Vertical agent**:
A statically registered, named business-level composition expressed as a type-checked TypeScript definition. It customizes agent resources and requests runtime policies while reusing the shared agent runtime. Its `buildPrompt` function maps business input to a task prompt; the runtime receives only that prompt and never interprets the business input. A vertical agent does not implement or own the underlying runtime, provider credentials, model catalog, or worker lifecycle. The runtime accepts only registered agent IDs and never discovers agents from arbitrary paths or task input.
_Avoid_: a separate agent runtime, a prompt with implicit privileges, dynamic agent discovery, untyped JSON manifest

**Shared agent runtime**:
The common Pi session, model configuration, authentication, worker lifecycle, concurrency limits, timeout, cleanup, and execution machinery reused by all vertical agents. It alone creates workers and controls their scheduling, but does not decide business success or mandate business validation.
_Avoid_: rebuilding an agent runtime per business agent, vertical-agent worker creation, generic business workflow engine

**Human decision**:
A structured instruction (test/prod/drop + optional remark) that resolves agent diagnostic uncertainty without granting new permissions.
_Avoid_: treating a decision as authorization to modify production code, free-text replies without command structure

**Awaiting decision**:
An escalated sub-state where the scene is freeze-dried and the bot waits for a /heal command.
_Avoid_: retaining scenes for non-decidable escalations, indefinite retention without TTL

**Resume**:
Cross-process session recovery that carries decision context into a continued repair pipeline.
_Avoid_: in-process session reuse (same worker), starting a fresh session without history

**Decision invalidation**:
Automatic voiding of an awaiting decision when a new pipeline arrives for the same MR (MR-scoped invalidation; falls back to project scope when mrIid is absent).
_Avoid_: manual invalidation, continuing repair on stale sha

**Supersede**:
The semantics by which a new commit on the same MR replaces bot work on an older sha. Three layers: queue coalescing (keep only the latest), in-flight steer (inject update notification at turn boundary into the live session), and terminal freshness gate (validate HEAD before createMR). Session continuity spans the entire lifecycle — session lifetime equals MR lifetime.
_Avoid_: treating supersede as discard-and-restart, per-sha repair MR branches

**Retained scene**:
The preserved cwd + worktree + session + branch set that enables resume.
_Avoid_: partial retention (session without worktree), permanent retention without TTL

**Repair replay**:
The git-level re-application of a previous repair's committed changes (range diff of the origin repair branch against the archived pipeline sha, three-way applied) into a freshly created worktree for a new pipeline on the same unmerged MR. The worktree itself is never reused — only the changes are replayed. Replay failure degrades atomically to a fresh repair.
_Avoid_: reusing the worktree directory across pipelines, cherry-picking commit history, replaying after MR terminal cleanup

## Dashboard

**EventHub**:
An in-memory event aggregator in the main process that receives structured events from the scheduler and worker IPC, maintains a system snapshot, and broadcasts to SSE clients. It is the single fan-out point between internal state changes and browser consumers.
_Avoid_: polling-only dashboards, direct database queries from the frontend, per-client state tracking

**IPC event**:
A typed JSON message sent from a worker subprocess to the main process via Node IPC (fd 3). It reports stage transitions, turn progress, and tool calls without coupling the worker to any notification transport.
_Avoid_: log scraping for progress, DingTalk from the worker for dashboard updates

**SSE (Server-Sent Events)**:
The unidirectional push channel from EventHub to browser clients over HTTP. Clients receive an initial snapshot on connect and incremental events thereafter; reconnection is handled by the browser's native EventSource API.
_Avoid_: WebSocket (unnecessary bidirectional complexity), polling-only dashboards

**SystemSnapshot**:
The current aggregate state (health, scheduler stats, active workers) maintained by the EventHub and pushed to each SSE client on connection.
_Avoid_: computing aggregate state per request, stale cached snapshots

**MetricsAggregator**:
An in-memory accumulator that preloads historical metrics from audit JSONL files at startup and receives incremental updates from completed repairs. Exposes a snapshot of counts, rates, and costs via the /api/metrics endpoint.
_Avoid_: real-time database queries for metrics, unbounded in-memory event history
