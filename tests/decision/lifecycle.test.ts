import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
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

describe("createDecisionLifecycle — onNewPipeline", () => {
	let dir: string;
	let store: DecisionStore;
	let sender: InMemoryDingTalkNotifier;
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
	): void {
		store.create({
			decision_id: decisionId,
			pipeline_id: "42",
			project_id: projectId,
			event_json: eventJson ?? JSON.stringify(makeEvent(projectId, 42)),
			cwd_path: cwd,
			session_path: join(cwd, ".pi-agent"),
			branch: "ci-self-heal/main-abcdef12",
			expires_at: new Date(Date.now() + 86_400_000).toISOString(),
		});
	}

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
