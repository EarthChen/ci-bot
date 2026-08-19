/**
 * End-to-end tracer-bullet test (ticket 01).
 *
 * Single test seam (per spec test decision): webhook → MR creation → DingTalk.
 * The agent is a stub; glab + DingTalk are fakes that persist to sidecar files
 * in the worker cwd. But everything ELSE is real: a real Fastify HTTP server
 * on an ephemeral port, a real scheduler queue, a real spawned subprocess
 * worker with isolated cwd/env, real signature + dedup logic.
 *
 * What this test encodes (the WHY, not just the WHAT):
 *  - A valid pipeline-failure webhook triggers exactly one MR + one success
 *    DingTalk (the core "self-heal" promise).
 *  - The MR diff touches ONLY test files (G3 permission boundary; the spec
 *    forbids bot from touching src/main — a test that only checked "an MR
 *    exists" couldn't catch a src-write regression).
 *  - A webhook with a bad token is rejected (forged requests can't trigger
 *    fixes — G7 security).
 *  - A retried webhook (same pipeline id) triggers the repair only ONCE
 *    (GitLab retries must not duplicate work — G2 idempotency).
 */

import { describe, it, expect, beforeAll, afterAll, afterEach } from "vitest";
import Fastify, { type FastifyInstance } from "fastify";
import { mkdtemp, rm, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Scheduler } from "../../src/agent-runtime/scheduler.js";
import { CI_REPAIR_SCHEDULING_POLICY } from "../../src/agent/ci-repair-definition.js";
import { SubprocessWorkerManager } from "../../src/worker/manager.js";
import { mountWebhook } from "../../src/webhook/receiver.js";
import { InMemoryDingTalkNotifier } from "../../src/notify/dingtalk.js";
import { createEscalationNotifier } from "../../src/notify/escalation-notifier.js";
import { ProjectRouter } from "../../src/notify/project-router.js";

const WEBHOOK_SECRET = "test-secret-token";
const WORK_ROOT = await mkdtemp(join(tmpdir(), "ciheal-e2e-"));

// Real subprocess worker manager: spawns `tsx src/worker/main.ts` per event.
// The worker reads CIHEAL_* env switches and uses stub agent + fake glab +
// fake dingtalk, persisting their calls to sidecar JSON files in its cwd.
const workerManager = new SubprocessWorkerManager({
  timeoutMs: 60_000,
  keepWork: true, // keep cwd so the test can read sidecars
  // CIHEAL_STUB_MR_STATUS=fail-then-pass 让监控首次 CI 失败、其后通过，
  // 以此驱动「复用 session 重试」全链路（仍应产出 mr 结果）。
  env: {
    CIHEAL_WORKTREE_MODE: "fake",
    CIHEAL_STUB_MR_STATUS: "fail-then-pass",
  },
});

const scheduler = new Scheduler({
  workerManager,
  workRoot: WORK_ROOT,
  maxWorkers: 1,
  policy: CI_REPAIR_SCHEDULING_POLICY,
});

let app: FastifyInstance;

beforeAll(async () => {
  app = Fastify({ logger: false });
  await mountWebhook(app, {
    scheduler,
    config: {
      webhookSecret: WEBHOOK_SECRET,
      ipAllowlist: [],
      rateLimitMax: 1000,
      rateLimitWindowMs: 60_000,
    },
  });
  await app.listen({ port: 0, host: "127.0.0.1" });
});

afterAll(async () => {
  await app.close();
  await rm(WORK_ROOT, { recursive: true, force: true }).catch(() => {});
});

afterEach(() => {
  // Reset rate-limit buckets between cases.
  // (module-level state; we re-import is overkill — just clear via fetch.)
});

function baseUrl(): string {
  const addr = app.server.address();
  if (addr && typeof addr === "object") {
    return `http://127.0.0.1:${(addr as { port: number }).port}`;
  }
  throw new Error("server not listening");
}

/** A canonical GitLab pipeline-failed webhook body (class-1 test bug fixture). */
function pipelineFailedBody(
  projectId: string | number,
  pipelineId: number,
  ref = "main",
  sha = "abc1234567890",
): unknown {
  return {
    object_kind: "pipeline",
    object_attributes: {
      id: pipelineId,
      ref,
      sha,
      status: "failed",
    },
    merge_request: { source_branch: ref, iid: pipelineId },
    project: {
      id: projectId,
      web_url: `https://gitlab.example.com/${projectId}`,
    },
  };
}

async function postWebhook(body: unknown, token = WEBHOOK_SECRET): Promise<{
  status: number;
  json: unknown;
}> {
  const res = await fetch(`${baseUrl()}/webhook/gitlab?repair=1`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-gitlab-token": token,
    },
    body: JSON.stringify(body),
  });
  const text = await res.text();
  let json: unknown = null;
  try {
    json = JSON.parse(text);
  } catch {
    json = text;
  }
  return { status: res.status, json };
}

/** Find the latest worker cwd under WORK_ROOT and read a sidecar JSON. */
async function readSidecar<T>(name: string): Promise<T | null> {
  const { readdir } = await import("node:fs/promises");
  const entries = await readdir(WORK_ROOT, { withFileTypes: true });
  // Pick the most recently created worker dir.
  const dirs = entries.filter((e) => e.isDirectory()).map((e) => e.name);
  for (const d of [...dirs].reverse()) {
    try {
      const raw = await readFile(join(WORK_ROOT, d, name), "utf8");
      return JSON.parse(raw) as T;
    } catch {
      // try next dir
    }
  }
  return null;
}

describe("tracer bullet: webhook → MR → DingTalk (ticket 01)", () => {
  it("validates signature and rejects forged webhooks (401)", async () => {
    const { status } = await postWebhook(
      pipelineFailedBody("proj-1", 999_001),
      "WRONG-TOKEN",
    );
    expect(status).toBe(401);
  });

  it("processes a class-1 pipeline failure into an MR + success DingTalk", async () => {
    const { status, json } = await postWebhook(
      pipelineFailedBody("proj-1", 900_100, "feature/x", "deadbeefcafebabe"),
    );
    expect(status).toBe(202);
    expect(json).toEqual({ status: "queued" });

    // Wait for the spawned worker to finish.
    await scheduler.idle();

    // DingTalk was notified exactly once, with a success title.
    const dingtalk = await readSidecar<
      Array<{ title: string; text: string }>
    >("dingtalk-sent.json");
    expect(dingtalk).not.toBeNull();
    expect(dingtalk!.length).toBe(1);
    expect(dingtalk![0].title).toContain("成功");

    // Exactly one MR outcome recorded. The current architecture has the agent
    // create the MR itself (git push + glab mr create) and return its URL;
    // the bot records the outcome via audit-trace.json (it does not call
    // glab). Assert on the authoritative git diff + outcome, not a sidecar
    // the bot no longer writes.
    const audit = await readSidecar<{
      event: { projectId: string };
      outcome: string;
      diagnosis: { failureClass: number; summary: string };
      mrUrl?: string;
      diff: string;
    }>("audit-trace.json");
    expect(audit).not.toBeNull();
    expect(audit!.outcome).toBe("mr");
    expect(audit!.mrUrl).toBeTruthy();
    expect(audit!.event.projectId).toBe("proj-1");
    expect(audit!.diagnosis.failureClass).toBe(1);

    // G3 permission boundary: the fix touches ONLY test files (src/main
    // forbidden). Assert on the authoritative git diff, not the MR body text
    // — this is the safety invariant that keeps the bot safe to run
    // unsupervised. A stub returning a src/main path would fail here (and is
    // covered by the G3-violation case below).
    expect(audit!.diff).toContain("CalculatorTest");
    expect(audit!.diff).not.toContain("src/main/");

    // Spill files the bot writes into the worktree (CI log / MR diff) must
    // never enter the authoritative patch (they would otherwise pollute the
    // diff and trip the diff-whitelist validator).
    expect(audit!.diff).not.toContain("ci-log");
    expect(audit!.diff).not.toContain("mr-diff.patch");

    // With CIHEAL_STUB_MR_STATUS=fail-then-pass the monitor forces one retry
    // (reuse session) before CI passes; the outcome must still be a mergeable MR.
    expect(audit!.outcome).toBe("mr");
  });

  it("dedupes retried webhooks for the same pipeline id", async () => {
    const first = await postWebhook(
      pipelineFailedBody("proj-2", 900_200, "main", "1111111111111111"),
    );
    expect(first.status).toBe(202);
    expect(first.json).toEqual({ status: "queued" });

    // GitLab retries the same pipeline while it's in-flight (or queued).
    const retry = await postWebhook(
      pipelineFailedBody("proj-2", 900_200, "main", "1111111111111111"),
    );
    expect(retry.status).toBe(202);
    expect(retry.json).toEqual({ status: "duplicate" });

    await scheduler.idle();

    // Only ONE MR outcome recorded for proj-2/900_200: the retry was deduped
    // by the scheduler, so the worker ran exactly once. The agent creates the
    // MR; the bot records the outcome via audit-trace.json.
    const audit = await readSidecar<{
      event: { projectId: string };
      outcome: string;
    }>("audit-trace.json");
    expect(audit).not.toBeNull();
    expect(audit!.event.projectId).toBe("proj-2");
    expect(audit!.outcome).toBe("mr");
  });

  it("ignores non-failed pipelines (no repair triggered)", async () => {
    const body = {
      object_kind: "pipeline",
      object_attributes: { id: 900_300, ref: "main", sha: "x", status: "success" },
      project: { id: "proj-3", web_url: "https://gitlab.example.com/proj-3" },
    };
    const { status, json } = await postWebhook(body);
    expect(status).toBe(202);
    expect(json).toEqual({ status: "ignored" });
    // Give the scheduler a beat; nothing should have run.
    expect(scheduler.stats().inflight).toBe(0);
  });

  it("enforces G3: a fix touching src/main escalates instead of creating an MR", async () => {
    // Separate worker manager + scheduler for this case: the stub returns a
    // production-path fix, which G3 must reject before any MR is created.
    const g3WorkRoot = await mkdtemp(join(tmpdir(), "ciheal-g3-"));
    const g3Manager = new SubprocessWorkerManager({
      timeoutMs: 60_000,
      keepWork: true,
      env: { CIHEAL_STUB_FIX_KIND: "src-main", CIHEAL_WORKTREE_MODE: "fake" },
    });
    // T04: escalated notifications are main-process + routed.
    const g3Escalations = new InMemoryDingTalkNotifier();
    const g3Scheduler = new Scheduler({
      workerManager: g3Manager,
      workRoot: g3WorkRoot,
      maxWorkers: 1,
      policy: CI_REPAIR_SCHEDULING_POLICY,
      escalationNotifier: createEscalationNotifier({
        router: new ProjectRouter({}, "cid-e2e-default"),
        sender: g3Escalations,
      }),
    });
    const g3App = Fastify({ logger: false });
    await mountWebhook(g3App, {
      scheduler: g3Scheduler,
      config: {
        webhookSecret: WEBHOOK_SECRET,
        ipAllowlist: [],
        rateLimitMax: 1000,
        rateLimitWindowMs: 60_000,
      },
    });
    await g3App.listen({ port: 0, host: "127.0.0.1" });
    const addr = g3App.server.address();
    const g3Base = `http://127.0.0.1:${(addr as { port: number }).port}`;

    try {
      const res = await fetch(`${g3Base}/webhook/gitlab?repair=1`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-gitlab-token": WEBHOOK_SECRET,
        },
        body: JSON.stringify(
          pipelineFailedBody("proj-g3", 900_400, "main", "feedface0011223344"),
        ),
      });
      expect(res.status).toBe(202);
      await g3Scheduler.idle();

      // Read sidecars from the G3 work root.
      const { readdir } = await import("node:fs/promises");
      const dirs = (await readdir(g3WorkRoot, { withFileTypes: true }))
        .filter((e) => e.isDirectory())
        .map((e) => e.name);
      let dingtalk: Array<{ title: string }> | null = null;
      let mrs: Array<{ projectId: string }> | null = null;
      for (const d of [...dirs].reverse()) {
        if (!dingtalk) {
          try {
            dingtalk = JSON.parse(
              await readFile(join(g3WorkRoot, d, "dingtalk-sent.json"), "utf8"),
            );
          } catch (e) {
            void e; // sidecar may not exist in this dir; try the next
          }
        }
        if (!mrs) {
          try {
            mrs = JSON.parse(
              await readFile(join(g3WorkRoot, d, "glab-mr-creates.json"), "utf8"),
            );
          } catch (e) {
            void e; // sidecar may not exist in this dir; try the next
          }
        }
      }

      // No MR created — G3 blocked the production-path fix.
      expect(mrs).toBeNull();
      // T04: the worker sent NO escalation notification (sidecar empty)...
      expect(dingtalk).toBeNull();
      // ...the main-process routed notification surfaced the block instead.
      expect(g3Escalations.sentGroups).toHaveLength(1);
      expect(g3Escalations.sentGroups[0].message.title).toContain("转交");
    } finally {
      await g3App.close();
      await rm(g3WorkRoot, { recursive: true, force: true }).catch(() => {});
    }
  });
});
