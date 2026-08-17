import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { InMemoryDingTalkNotifier } from "../../src/notify/dingtalk.js";
import { ProjectRouter } from "../../src/notify/project-router.js";
import { DecisionStore } from "../../src/decision/store.js";
import { createDecisionLifecycle } from "../../src/decision/lifecycle.js";
import type { PipelineEvent } from "../../src/types.js";

function makeEvent(projectId: string, pipelineId: number): PipelineEvent {
	return {
		projectId,
		pipelineId,
		ref: "main",
		sha: "abcdef1234567890",
		projectUrl: `https://git.example.com/${projectId}`,
	};
}

// Shared fixture — both describes below bind these in their beforeEach.
let dir: string;
let store: DecisionStore;
let sender: InMemoryDingTalkNotifier;

/** Retained scene on disk that cleanupScene must remove. */
function makeScene(name: string): string {
	const cwd = join(dir, name);
	mkdirSync(cwd, { recursive: true });
	writeFileSync(join(cwd, "result.json"), "{}", "utf8");
	return cwd;
}

function seedAwaiting(
	decisionId: string,
	projectId: string,
	cwd: string,
	eventJson?: string,
	expiresAt?: string,
): void {
	store.create({
		decision_id: decisionId,
		pipeline_id: "42",
		project_id: projectId,
		event_json: eventJson ?? JSON.stringify(makeEvent(projectId, 42)),
		cwd_path: cwd,
		session_path: join(cwd, ".pi-agent"),
		branch: "ci-self-heal/main-abcdef12",
		expires_at:
			expiresAt ?? new Date(Date.now() + 86_400_000).toISOString(),
	});
}

describe("createDecisionLifecycle — onNewPipeline", () => {
	/** Static route proj-A → cid-A; empty default → everything else unrouted. */
	const router = () => new ProjectRouter({ "proj-A": "cid-A" }, "");

	beforeEach(() => {
		dir = mkdtempSync(join(tmpdir(), "decision-lifecycle-"));
		store = new DecisionStore(join(dir, "decisions.db"));
		sender = new InMemoryDingTalkNotifier();
	});

	afterEach(() => {
		store.close();
		rmSync(dir, { recursive: true, force: true });
	});

	it("invalidates all awaiting decisions, cleans their scenes, and sends ONE routed notification", async () => {
		const cwd1 = makeScene("work-42");
		const cwd2 = makeScene("work-43");
		seedAwaiting("D-42-ab12", "proj-A", cwd1);
		seedAwaiting("D-43-cd34", "proj-A", cwd2);
		const lifecycle = createDecisionLifecycle({ store, router: router(), sender });

		await lifecycle.onNewPipeline(makeEvent("proj-A", 999));

		const d1 = store.get("D-42-ab12")!;
		const d2 = store.get("D-43-cd34")!;
		expect(d1.status).toBe("invalidated");
		expect(d1.decided_by).toBe("system:new-pipeline");
		expect(d1.decided_at).toBeTruthy();
		expect(d2.status).toBe("invalidated");
		expect(existsSync(cwd1)).toBe(false);
		expect(existsSync(cwd2)).toBe(false);

		expect(sender.sentGroups).toHaveLength(1);
		const { conversationId, message } = sender.sentGroups[0];
		expect(conversationId).toBe("cid-A");
		expect(message.title).toBe("CI 自愈决策已作废");
		expect(message.text).toContain("项目 proj-A");
		expect(message.text).toContain("#999");
		expect(message.text).toContain("D-42-ab12");
		expect(message.text).toContain("D-43-cd34");
	});

	it("no awaiting decisions → silent no-op (no notification)", async () => {
		const cwd = makeScene("work-44");
		store.create({
			decision_id: "D-closed",
			pipeline_id: "44",
			project_id: "proj-A",
			event_json: JSON.stringify(makeEvent("proj-A", 44)),
			cwd_path: cwd,
			session_path: join(cwd, ".pi-agent"),
			branch: "ci-self-heal/main-abcdef12",
			status: "closed",
			expires_at: new Date(Date.now() + 86_400_000).toISOString(),
		});
		const lifecycle = createDecisionLifecycle({ store, router: router(), sender });

		await lifecycle.onNewPipeline(makeEvent("proj-A", 999));

		expect(store.get("D-closed")!.status).toBe("closed");
		expect(existsSync(cwd)).toBe(true); // untouched scene
		expect(sender.sentGroups).toEqual([]);
	});

	it("unrouted project → invalidates and cleans, but skips the notification", async () => {
		const cwd = makeScene("work-45");
		seedAwaiting("D-45-ef56", "proj-X", cwd);
		const lifecycle = createDecisionLifecycle({ store, router: router(), sender });

		await expect(
			lifecycle.onNewPipeline(makeEvent("proj-X", 999)),
		).resolves.toBeUndefined();

		expect(store.get("D-45-ef56")!.status).toBe("invalidated");
		expect(existsSync(cwd)).toBe(false);
		expect(sender.sentGroups).toEqual([]);
	});

	it("terminal-state rows are never transitioned", async () => {
		const cwd = makeScene("work-46");
		seedAwaiting("D-46-awaiting", "proj-A", cwd);
		for (const [i, status] of ["resumed", "closed", "dropped", "expired"].entries()) {
			store.create({
				decision_id: `D-46-${status}`,
				pipeline_id: "46",
				project_id: "proj-A",
				event_json: JSON.stringify(makeEvent("proj-A", 46)),
				cwd_path: join(dir, `terminal-${i}`),
				session_path: join(dir, `terminal-${i}`, ".pi-agent"),
				branch: "ci-self-heal/main-abcdef12",
				status: status as never,
				expires_at: new Date(Date.now() + 86_400_000).toISOString(),
			});
		}
		const lifecycle = createDecisionLifecycle({ store, router: router(), sender });

		await lifecycle.onNewPipeline(makeEvent("proj-A", 999));

		expect(store.get("D-46-awaiting")!.status).toBe("invalidated");
		for (const status of ["resumed", "closed", "dropped", "expired"]) {
			expect(store.get(`D-46-${status}`)!.status).toBe(status);
		}
		// ONE notification listing only the invalidated id.
		expect(sender.sentGroups).toHaveLength(1);
		expect(sender.sentGroups[0].message.text).toContain("D-46-awaiting");
		expect(sender.sentGroups[0].message.text).not.toContain("D-46-closed");
	});

	it("corrupt event_json never throws — remaining scenes still cleaned and notified", async () => {
		const cwdGood = makeScene("work-47");
		const cwdBad = makeScene("work-48");
		seedAwaiting("D-47-good", "proj-A", cwdGood);
		seedAwaiting("D-48-corrupt", "proj-A", cwdBad, "{not-json");
		const lifecycle = createDecisionLifecycle({ store, router: router(), sender });

		await expect(
			lifecycle.onNewPipeline(makeEvent("proj-A", 999)),
		).resolves.toBeUndefined();

		expect(store.get("D-47-good")!.status).toBe("invalidated");
		expect(store.get("D-48-corrupt")!.status).toBe("invalidated");
		expect(existsSync(cwdGood)).toBe(false);
		// The corrupt record could not be cleaned, but it must not block the flow.
		expect(sender.sentGroups).toHaveLength(1);
		expect(sender.sentGroups[0].message.text).toContain("D-47-good");
		expect(sender.sentGroups[0].message.text).toContain("D-48-corrupt");
	});
});

describe("createDecisionLifecycle — startTtlSweep", () => {
	let lifecycle: ReturnType<typeof createDecisionLifecycle>;
	/** proj-A → cid-A, proj-B → cid-B; everything else unrouted. */
	const router = () =>
		new ProjectRouter({ "proj-A": "cid-A", "proj-B": "cid-B" }, "");
	const pastExpiry = () => new Date(Date.now() - 1000).toISOString();

	beforeEach(() => {
		vi.useFakeTimers();
		vi.setSystemTime(new Date("2026-08-17T12:00:00.000Z"));
		dir = mkdtempSync(join(tmpdir(), "decision-sweep-"));
		store = new DecisionStore(join(dir, "decisions.db"));
		sender = new InMemoryDingTalkNotifier();
		lifecycle = createDecisionLifecycle({ store, router: router(), sender });
	});

	afterEach(() => {
		store.close();
		rmSync(dir, { recursive: true, force: true });
		vi.useRealTimers();
	});

	it("expired decisions are swept, scenes cleaned, ONE routed notification per project", async () => {
		const cwd1 = makeScene("work-50");
		const cwd2 = makeScene("work-51");
		seedAwaiting("D-50-ab12", "proj-A", cwd1, undefined, pastExpiry());
		seedAwaiting("D-51-cd34", "proj-A", cwd2, undefined, pastExpiry());
		seedAwaiting("D-52-live", "proj-A", makeScene("work-52")); // future expiry
		const handle = lifecycle.startTtlSweep({ intervalMs: 1000 });
		try {
			await vi.advanceTimersByTimeAsync(1000);
			await vi.waitFor(() => expect(sender.sentGroups).toHaveLength(1));

			expect(store.get("D-50-ab12")).toBeUndefined();
			expect(store.get("D-51-cd34")).toBeUndefined();
			expect(store.get("D-52-live")).toBeDefined();
			expect(existsSync(cwd1)).toBe(false);
			expect(existsSync(cwd2)).toBe(false);

			const { conversationId, message } = sender.sentGroups[0];
			expect(conversationId).toBe("cid-A");
			expect(message.title).toBe("CI 自愈决策超时关闭");
			expect(message.text).toContain("项目 proj-A");
			expect(message.text).toContain("D-50-ab12");
			expect(message.text).toContain("D-51-cd34");
			expect(message.text).not.toContain("D-52-live");
		} finally {
			handle.stop();
		}
	});

	it("empty tick is silent (no message, no state change)", async () => {
		seedAwaiting("D-53-live", "proj-A", makeScene("work-53")); // future expiry
		const handle = lifecycle.startTtlSweep({ intervalMs: 1000 });
		try {
			await vi.advanceTimersByTimeAsync(3000); // three silent ticks
			expect(sender.sentGroups).toEqual([]);
			expect(store.get("D-53-live")).toBeDefined();
		} finally {
			handle.stop();
		}
	});

	it("multi-project tick sends ONE message per project with grouped ids", async () => {
		seedAwaiting("D-54-a", "proj-A", makeScene("work-54a"), undefined, pastExpiry());
		seedAwaiting("D-55-b", "proj-B", makeScene("work-54b"), undefined, pastExpiry());
		const handle = lifecycle.startTtlSweep({ intervalMs: 1000 });
		try {
			await vi.advanceTimersByTimeAsync(1000);
			await vi.waitFor(() => expect(sender.sentGroups).toHaveLength(2));

			const toA = sender.sentGroups.find((m) => m.conversationId === "cid-A")!;
			const toB = sender.sentGroups.find((m) => m.conversationId === "cid-B")!;
			expect(toA.message.text).toContain("D-54-a");
			expect(toA.message.text).not.toContain("D-55-b");
			expect(toB.message.text).toContain("D-55-b");
			expect(toB.message.text).not.toContain("D-54-a");
		} finally {
			handle.stop();
		}
	});

	it("stop() halts the timer (no sweep afterwards)", async () => {
		seedAwaiting("D-56-x", "proj-A", makeScene("work-56"), undefined, pastExpiry());
		const handle = lifecycle.startTtlSweep({ intervalMs: 1000 });
		handle.stop();

		await vi.advanceTimersByTimeAsync(5000);

		expect(store.get("D-56-x")).toBeDefined();
		expect(sender.sentGroups).toEqual([]);
	});

	it("unrouted project → swept and cleaned, notification skipped", async () => {
		const cwd = makeScene("work-57");
		seedAwaiting("D-57-u", "proj-X", cwd, undefined, pastExpiry());
		const handle = lifecycle.startTtlSweep({ intervalMs: 1000 });
		try {
			await vi.advanceTimersByTimeAsync(1000);
			expect(store.get("D-57-u")).toBeUndefined(); // sweep ran
			await vi.waitFor(() => expect(existsSync(cwd)).toBe(false));
			expect(sender.sentGroups).toEqual([]);
		} finally {
			handle.stop();
		}
	});

	it("a failing tick never crashes the timer — the next tick retries", async () => {
		seedAwaiting("D-58-r", "proj-A", makeScene("work-58"), undefined, pastExpiry());
		const spy = vi
			.spyOn(store, "sweepExpired")
			.mockImplementation(() => {
				throw new Error("db locked");
			});
		const handle = lifecycle.startTtlSweep({ intervalMs: 1000 });
		try {
			await vi.advanceTimersByTimeAsync(1000); // tick 1 fails internally
			expect(store.get("D-58-r")).toBeDefined();

			spy.mockRestore();
			await vi.advanceTimersByTimeAsync(1000); // tick 2 retries
			await vi.waitFor(() => expect(sender.sentGroups).toHaveLength(1));
			expect(store.get("D-58-r")).toBeUndefined();
		} finally {
			handle.stop();
			spy.mockRestore();
		}
	});

	it("interval precedence opts > env > default 60s, and the timer is unref'd", () => {
		const spy = vi.spyOn(globalThis, "setInterval");
		try {
			let handle = lifecycle.startTtlSweep();
			expect(spy.mock.calls[0][1]).toBe(60_000);
			handle.stop();

			process.env.CIHEAL_DECISION_SWEEP_INTERVAL_MS = "250";
			handle = lifecycle.startTtlSweep();
			expect(spy.mock.calls[1][1]).toBe(250);
			handle.stop();

			handle = lifecycle.startTtlSweep({ intervalMs: 999 });
			expect(spy.mock.calls[2][1]).toBe(999);
			const timer = spy.mock.results[2].value as { hasRef(): boolean };
			expect(timer.hasRef()).toBe(false); // unref() → bot can exit cleanly
			handle.stop();
		} finally {
			delete process.env.CIHEAL_DECISION_SWEEP_INTERVAL_MS;
			spy.mockRestore();
		}
	});
});
