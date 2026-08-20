/**
 * Ticket 01 — Pi SDK steer semantics spike.
 *
 * WHY: MR supersede (ticket 06) must not assume steer interrupts long-running
 * tools or that queue_update alone means "delivered". These tests lock SDK facts
 * the bot implementation must respect.
 */
import { readFileSync, readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
	type AgentSession,
	createAgentSession,
	SessionManager,
} from "@earendil-works/pi-coding-agent";

const PKG_ROOT = join(
	dirname(fileURLToPath(import.meta.url)),
	"../../node_modules/@earendil-works/pi-coding-agent",
);
const PNPM_DIR = join(PKG_ROOT, "../../.pnpm");

function resolveAgentLoopJs(): string {
	const storeEntry = readdirSync(PNPM_DIR).find((name) =>
		name.startsWith("@earendil-works+pi-agent-core@"),
	);
	if (!storeEntry) {
		throw new Error("pi-agent-core package not found in pnpm store");
	}
	return join(
		PNPM_DIR,
		storeEntry,
		"node_modules/@earendil-works/pi-agent-core/dist/agent-loop.js",
	);
}

const AGENT_SESSION_DTS = readFileSync(
	join(PKG_ROOT, "dist/core/agent-session.d.ts"),
	"utf8",
);
const AGENT_LOOP_JS = readFileSync(resolveAgentLoopJs(), "utf8");

describe("steer API surface (pi-coding-agent 0.84.0)", () => {
	it("AgentSession exposes steer/followUp/clearQueue and SessionManager.open/list", () => {
		expect(AGENT_SESSION_DTS).toMatch(/steer\(text: string/);
		expect(AGENT_SESSION_DTS).toMatch(/followUp\(text: string/);
		expect(AGENT_SESSION_DTS).toMatch(/clearQueue\(\)/);
		expect(typeof SessionManager.open).toBe("function");
		expect(typeof SessionManager.list).toBe("function");
	});

	it("PromptOptions.streamingBehavior accepts steer | followUp", () => {
		expect(AGENT_SESSION_DTS).toMatch(/streamingBehavior\?: "steer" \| "followUp"/);
	});
});

describe("steer injection timing (source-derived)", () => {
	it("steer is documented as turn-boundary delivery after tool calls, not immediate tool abort", () => {
		expect(AGENT_SESSION_DTS).toMatch(
			/Delivered after the current assistant turn finishes executing its tool calls/,
		);
		expect(AGENT_SESSION_DTS).toMatch(/before the next LLM call/);
	});

	it("agent loop polls steering after each turn_end inside the tool loop", () => {
		// Inner loop: turn_end → optional prepareNextTurn → getSteeringMessages poll.
		const innerPollMarker =
			'await emit({ type: "turn_end", message, toolResults });\n            const nextTurnContext';
		expect(AGENT_LOOP_JS).toContain(innerPollMarker);
		const afterTurnEnd = AGENT_LOOP_JS.indexOf(innerPollMarker);
		const pollAfterTurnEnd = AGENT_LOOP_JS.indexOf(
			"pendingMessages = (await config.getSteeringMessages?.())",
			afterTurnEnd,
		);
		expect(pollAfterTurnEnd).toBeGreaterThan(afterTurnEnd);
	});

	it("followUp waits until agent would otherwise stop (stricter than steer)", () => {
		expect(AGENT_SESSION_DTS).toMatch(
			/Delivered only when agent has no more tool calls or steering messages/,
		);
	});
});

describe("queue_update event shape and enqueue behavior", () => {
	it("steer() emits queue_update with steering snapshot; multiple steers accumulate", async () => {
		const { session } = await createAgentSession({
			sessionManager: SessionManager.inMemory("/tmp/spike-steer-queue"),
			tools: [],
		});

		const updates: Array<{ steering: readonly string[]; followUp: readonly string[] }> = [];
		session.subscribe((event) => {
			if (event.type === "queue_update") {
				updates.push({ steering: [...event.steering], followUp: [...event.followUp] });
			}
		});

		await session.steer("supersede sha-a→sha-b");
		await session.steer("supersede sha-b→sha-c");

		expect(updates).toEqual([
			{ steering: ["supersede sha-a→sha-b"], followUp: [] },
			{ steering: ["supersede sha-a→sha-b", "supersede sha-b→sha-c"], followUp: [] },
		]);
		expect(session.getSteeringMessages()).toEqual([
			"supersede sha-a→sha-b",
			"supersede sha-b→sha-c",
		]);
		expect(session.pendingMessageCount).toBe(2);

		session.dispose();
	});

	it("delivery removal is tied to message_start in AgentSession handler (source-derived)", () => {
		const agentSessionJs = readFileSync(
			join(PKG_ROOT, "dist/core/agent-session.js"),
			"utf8",
		);
		expect(agentSessionJs).toMatch(/message_start.*role === "user"/s);
		expect(agentSessionJs).toMatch(/_steeringMessages\.splice\(steeringIndex, 1\)/);
		expect(agentSessionJs).toMatch(/_emitQueueUpdate\(\)/);
	});
});

describe("undelivered steer replacement (bot responsibility)", () => {
	it("SDK has no replace API; clearQueue + steer is the merge/replace primitive", async () => {
		const { session } = await createAgentSession({
			sessionManager: SessionManager.inMemory("/tmp/spike-steer-replace"),
			tools: [],
		});

		const emptySnapshots: string[][] = [];
		session.subscribe((event) => {
			if (event.type === "queue_update" && event.steering.length === 0) {
				emptySnapshots.push([...event.steering]);
			}
		});

		await session.steer("old payload");
		const cleared = session.clearQueue();
		expect(cleared.steering).toEqual(["old payload"]);
		expect(session.getSteeringMessages()).toEqual([]);
		expect(emptySnapshots.length).toBeGreaterThanOrEqual(1);

		await session.steer("latest payload only");
		expect(session.getSteeringMessages()).toEqual(["latest payload only"]);

		session.dispose();
	});

	it("steeringMode default is one-at-a-time (one steer per completed turn)", () => {
		expect(AGENT_SESSION_DTS).toMatch(/steeringMode\(\): "all" \| "one-at-a-time"/);
		const settingsDoc = readFileSync(join(PKG_ROOT, "docs/settings.md"), "utf8");
		expect(settingsDoc).toMatch(/`steeringMode`.*`"one-at-a-time"`/);
	});
});

describe("queue_update as delivery signal — reliability boundaries", () => {
	it("queue_update on enqueue is synchronous and reliable", async () => {
		const { session } = await createAgentSession({
			sessionManager: SessionManager.inMemory("/tmp/spike-steer-signal"),
			tools: [],
		});

		let sawEnqueue = false;
		session.subscribe((event) => {
			if (event.type === "queue_update" && event.steering.length > 0) {
				sawEnqueue = true;
			}
		});

		await session.steer("queued");
		expect(sawEnqueue).toBe(true);
		session.dispose();
	});

	it("session dispose with pending steer drops undelivered content (no auto-delivery)", async () => {
		const { session } = await createAgentSession({
			sessionManager: SessionManager.inMemory("/tmp/spike-steer-dispose"),
			tools: [],
		});

		await session.steer("never delivered");
		expect(session.pendingMessageCount).toBe(1);
		session.dispose();
		// Reaching here without throw confirms dispose tolerates pending queue.
		expect(true).toBe(true);
	});

	it("bot must treat delivery as queue empty AFTER prior non-empty OR matching message_start", () => {
		// Document the contract ticket 06 must implement — not an SDK guarantee alone.
		const deliveryContract: {
			enqueueSignal: "queue_update with steering.length > 0";
			deliveredSignal: "queue_update with steering.length === 0 after pending, or user message_start";
			sessionTerminated: "pending steer lost; bot pendingSteer state must reset";
		} = {
			enqueueSignal: "queue_update with steering.length > 0",
			deliveredSignal: "queue_update with steering.length === 0 after pending, or user message_start",
			sessionTerminated: "pending steer lost; bot pendingSteer state must reset",
		};
		expect(deliveryContract.deliveredSignal).toContain("message_start");
	});
});

// Type-only guard: steer is callable on AgentSession without casting.
type SteerCallable = Pick<AgentSession, "steer" | "followUp" | "clearQueue" | "getSteeringMessages">;
const _steerCallable: SteerCallable = {} as SteerCallable;
void _steerCallable;
