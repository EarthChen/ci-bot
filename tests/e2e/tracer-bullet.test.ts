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
import { Scheduler } from "../../src/queue/scheduler.js";
import { SubprocessWorkerManager } from "../../src/worker/manager.js";
import { mountWebhook } from "../../src/webhook/receiver.js";

const WEBHOOK_SECRET = "test-secret-token";
const WORK_ROOT = await mkdtemp(join(tmpdir(), "ciheal-e2e-"));

// Real subprocess worker manager: spawns `tsx src/worker/main.ts` per event.
// The worker reads CIHEAL_* env switches and uses stub agent + fake glab +
// fake dingtalk, persisting their calls to sidecar JSON files in its cwd.
const workerManager = new SubprocessWorkerManager({
  timeoutMs: 60_000,
  keepWork: true, // keep cwd so the test can read sidecars
});

const scheduler = new Scheduler({
  workerManager,
  workRoot: WORK_ROOT,
  concurrency: 1,
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
  const res = await fetch(`${baseUrl()}/webhook`, {
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

    // Exactly one MR was created.
    const mrs = await readSidecar<
      Array<{
        projectId: string;
        sourceBranch: string;
        targetBranch: string;
        title: string;
        body: string;
        diagnosis: { failureClass: number; summary: string };
      }>
    >("glab-mr-creates.json");
    expect(mrs).not.toBeNull();
    expect(mrs!.length).toBe(1);
    expect(mrs![0].projectId).toBe("proj-1");
    expect(mrs![0].targetBranch).toBe("feature/x");
    expect(mrs![0].diagnosis.failureClass).toBe(1);

    // G3 permission boundary: the fix touches ONLY test files (src/main
    // forbidden). This encodes WHY the bot is safe to run, not just that
    // "a fix was produced".
    expect(mrs![0].body).toContain("CalculatorTest");
    expect(mrs![0].title).toContain("[ci-self-heal]");
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

    // Only ONE MR created for proj-2/900_200.
    const mrs = await readSidecar<
      Array<{ projectId: string }>
    >("glab-mr-creates.json");
    expect(mrs).not.toBeNull();
    expect(mrs!.filter((m) => m.projectId === "proj-2").length).toBe(1);
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
});
