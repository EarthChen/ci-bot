# 06 — Sandbox & security (.m2 read-only, restricted user, audit archive, supply chain)

**What to build:** Harden the worker execution environment per G5. Directory isolation (already in ticket 01) is reinforced; .m2 is mounted read-only for reuse (no write contamination); workers run under a restricted OS user with ~/.ssh, ~/.aws etc. blocked; all diffs and LLM reasoning traces (diagnosis conclusion, root cause, repair rationale) are archived for post-hoc traceability; dependency versions pinned + pnpm-lock + pnpm audit; MCP server sources limited to official/trusted. Write permission enforced: test/docs only, src/main banned (G3). Threat model B (internal trusted, LLM produces errors not malicious); evolution seam documented for container/microVM if threat escalates.

**Blocked by:** 01 (tracer bullet — needs a worker to harden)

**Status:** ready-for-agent

- [ ] .m2 mounted read-only into worker (reuse Maven cache, no write contamination)
- [ ] Restricted OS user for worker execution; ~/.ssh, ~/.aws, ~/.config etc. blocked (chmod + restricted user)
- [ ] LLM audit archive: diff + MR description + reasoning traces (diagnosis/root-cause/repair-rationale) persisted to log/object storage
- [ ] Supply chain: version pin + pnpm-lock committed + pnpm audit in CI; MCP server sources limited to official/trusted
- [ ] Write permission enforced programmatically: test/docs dirs writable, src/main rejected
- [ ] Permission matrix implemented: checkout R/W (test/docs), spec R/W (behavior change), .m2 R-only, secrets R-only (chmod 600)
- [ ] Evolution seam documented: threat model A (prompt injection) → add container/microVM (gVisor/Firecracker); kernel-level not layer-7
- [ ] Tests assert: src write rejected; .m2 write rejected; secret files not readable by worker beyond .env
