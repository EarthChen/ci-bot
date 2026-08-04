# 01 — Tracer bullet: webhook → stub fix → MR + DingTalk

**What to build:** Send a fake GitLab pipeline-failed webhook; the bot verifies the signature, deduplicates by pipeline id, spawns one worker (cwd-isolated), runs a stub agent that returns a canned fix diff, opens an MR with a fix summary, and pushes a DingTalk success notification. The entire pipeline is wired end-to-end with stubs at the agent and verification layers. This establishes the single end-to-end test seam and the first fixture row.

**Blocked by:** None — can start immediately.

**Status:** ready-for-agent

- [ ] GitLab webhook receiver accepts pipeline-failed events, verifies `X-Gitlab-Token` signature, applies IP allowlist + rate limit
- [ ] Pipeline-id idempotent dedup (retried webhook triggers only one fix)
- [ ] In-memory queue with global concurrency cap N=1
- [ ] Worker supervisor spawns one worker subprocess with per-worker cwd isolation
- [ ] Stub agent runner returns canned diagnosis + fix diff (no real pi SDK yet)
- [ ] glab CLI wrapper creates MR with fix summary (no real MR opened in test — glab calls intercepted by fixture)
- [ ] DingTalk notification sent on fix success (deterministic node, bot code calls DingTalk, agent holds no DingTalk tool)
- [ ] .env config loader reads GitLab token + DingTalk webhook + model API key (chmod 600, gitignored)
- [ ] TS project skeleton (pnpm + tsconfig + src layout) committed
- [ ] End-to-end test exercises webhook → MR creation → DingTalk with stub agent fixture; first test-seam row green
