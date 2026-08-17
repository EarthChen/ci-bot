/**
 * E2E acceptance gate for the human-decision-resume feature (T11).
 *
 * Real subprocess workers + env-switch DI + sidecar/durable audit, covering
 * every acceptance scenario of the spec's Testing Decisions / User Stories:
 *
 *   1. happy path   decidable escalation → routed decision message (id + /heal
 *                   template parsed out of the message) → /heal test → resume
 *                   worker → mr outcome; audit carries decisionId + chainDepth;
 *                   scene cleaned after the resume
 *   2. prod         /heal prod → closed + scene removed + reply; no worker
 *   3. drop         /heal drop → dropped + scene removed + reply
 *   4. TTL expiry   short-TTL decision → sweep tick → scene removed + routed
 *                   timeout notification; /heal afterwards answers 未找到
 *   5. invalidation new webhook for same project → decision invalidated +
 *                   scene removed + routed 作废 notification; the new
 *                   pipeline's own flow unaffected
 *   6. terminal     resume escalates again → ONE routed terminal notification,
 *                   NO new decision row, scene cleaned
 *   7. rejections   unknown id / consumed id / private chat → informative
 *                   replies, zero state change
 *   8. restart      close + reopen the store on the same db → pending decision
 *                   survives and is /heal-able (SQLite persistence)
 *
 * Session-level proof limits (T11 design #3): stub agent modes prove the
 * orchestration (envelope → resume worker → outcome → audit), NOT a real Pi
 * session re-open — that is covered by tests/agent/real-runner-resume.test.ts.
 */

import { describe, it, expect, afterEach, vi } from "vitest";
import {
	existsSync,
	mkdirSync,
	mkdtempSync,
	readdirSync,
	readFileSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Scheduler } from "../../src/agent-runtime/scheduler.js";
import { CI_REPAIR_SCHEDULING_POLICY } from "../../src/agent/ci-repair-definition.js";
import { SubprocessWorkerManager } from "../../src/worker/manager.js";
import { DecisionStore } from "../../src/decision/store.js";
import type { DecisionRecord } from "../../src/decision/store.js";
import { handleHealCommand } from "../../src/decision/heal-command.js";
import { createDecisionLifecycle } from "../../src/decision/lifecycle.js";
import { createEscalationNotifier } from "../../src/notify/escalation-notifier.js";
import { ProjectRouter } from "../../src/notify/project-router.js";
import { InMemoryDingTalkNotifier } from "../../src/notify/dingtalk.js";
import type { DingTalkIncomingMessage } from "../../src/notify/stream-bot.js";
import type { PipelineEvent } from "../../src/types.js";

const PROJECT = "proj-hd";
const CONV = "cid-hd";

function makeEvent(pipelineId: number): PipelineEvent {
	return {
		projectId: PROJECT,
		pipelineId,
		ref: "main",
		sha: "abc1234567890",
		projectUrl: `https://gitlab.example.com/${PROJECT}`,
	};
}

function groupMessage(
	text: string,
	overrides: Partial<DingTalkIncomingMessage> = {},
): DingTalkIncomingMessage {
	return {
		text,
		senderStaffId: "staff-hd",
		senderNick: "HD",
		conversationId: CONV,
		conversationType: "group",
		sessionWebhook: "https://oapi.dingtalk.com/robot/sendByMsg?session=x",
		robotCode: "robot-hd",
		messageId: "msg-hd",
		...overrides,
	};
}

/** Shared env for every spawned worker in this suite. */
function baseWorkerEnv(dataRoot: string): Record<string, string> {
	return {
		CIHEAL_GLAB_MODE: "fake",
		CIHEAL_DINGTALK_MODE: "fake",
		CIHEAL_WORKTREE_MODE: "fake",
		CIHEAL_DATA_ROOT: dataRoot,
	};
}

/** The decidable-escalation repair fixture (agent-sourced, with diagnosis). */
const REPAIR_ESCALATE_ENV = {
	CIHEAL_AGENT_MODE: "real",
	CIHEAL_SESSION_FACTORY: "stub",
	CIHEAL_STUB_FIX_KIND: "class3-no-spec",
};

interface HdBot {
	readonly dataRoot: string;
	readonly store: DecisionStore;
	readonly escalations: InMemoryDingTalkNotifier;
	readonly replies: InMemoryDingTalkNotifier;
	readonly schedulerRepair: Scheduler;
	readonly schedulerResume: Scheduler;
	readonly enqueueResumeSpy: ReturnType<typeof vi.fn>;
	readonly lifecycle: ReturnType<typeof createDecisionLifecycle>;
	heal(text: string, overrides?: Partial<DingTalkIncomingMessage>): Promise<boolean>;
	teardown(): void;
}

/**
 * One acceptance environment: real DecisionStore + routed recorders + a REPAIR
 * scheduler/manager and a RESUME scheduler/manager (separate managers because
 * the stub fixtures freeze their behavior in per-manager env).
 */
function buildBot(opts: {
	repairEnv: Record<string, string>;
	resumeEnv: Record<string, string>;
}): HdBot {
	const root = mkdtempSync(join(tmpdir(), "hd-e2e-"));
	const dataRoot = join(root, "data");
	const workRoot = join(root, "work");
	mkdirSync(dataRoot, { recursive: true });
	mkdirSync(workRoot, { recursive: true });

	const store = new DecisionStore(join(dataRoot, "decisions.db"));
	const router = new ProjectRouter({ [PROJECT]: CONV }, "");
	const escalations = new InMemoryDingTalkNotifier();
	const replies = new InMemoryDingTalkNotifier();
	const notifier = createEscalationNotifier({ router, sender: escalations });
	const lifecycle = createDecisionLifecycle({
		store,
		router,
		sender: escalations,
	});

	const repairManager = new SubprocessWorkerManager({
		timeoutMs: 60_000,
		env: { ...baseWorkerEnv(dataRoot), ...opts.repairEnv },
	});
	const resumeManager = new SubprocessWorkerManager({
		timeoutMs: 60_000,
		env: { ...baseWorkerEnv(dataRoot), ...opts.resumeEnv },
	});
	const schedulerRepair = new Scheduler({
		workerManager: repairManager,
		workRoot,
		policy: CI_REPAIR_SCHEDULING_POLICY,
		maxWorkers: 1,
		decisionStore: store,
		escalationNotifier: notifier,
	});
	const schedulerResume = new Scheduler({
		workerManager: resumeManager,
		workRoot,
		policy: CI_REPAIR_SCHEDULING_POLICY,
		maxWorkers: 1,
		decisionStore: store,
		escalationNotifier: notifier,
	});
	const enqueueResumeSpy = vi.fn((record: DecisionRecord) =>
		schedulerResume.enqueueResume(record),
	);

	return {
		dataRoot,
		store,
		escalations,
		replies,
		schedulerRepair,
		schedulerResume,
		enqueueResumeSpy,
		lifecycle,
		async heal(text, overrides = {}) {
			return handleHealCommand(
				{
					store,
					reply: (conversationId, message) =>
						replies.sendTo(conversationId, message),
					enqueueResume: enqueueResumeSpy,
				},
				groupMessage(text, overrides),
			);
		},
		teardown() {
			store.close();
			rmSync(root, { recursive: true, force: true });
		},
	};
}

/** Seed an awaiting decision with a retained scene dir (no subprocess). */
function seedScene(
	bot: HdBot,
	decisionId: string,
	event: PipelineEvent,
	expiresAt?: string,
): string {
	const cwd = join(bot.dataRoot, "scenes", decisionId);
	mkdirSync(cwd, { recursive: true });
	writeFileSync(join(cwd, "marker.txt"), "retained scene", "utf8");
	bot.store.create({
		decision_id: decisionId,
		pipeline_id: String(event.pipelineId),
		project_id: event.projectId,
		event_json: JSON.stringify(event),
		cwd_path: cwd,
		session_path: join(cwd, ".pi-agent"),
		branch: `ci-self-heal/${event.ref}-${event.sha.slice(0, 8)}`,
		expires_at:
			expiresAt ?? new Date(Date.now() + 86_400_000).toISOString(),
	});
	return cwd;
}

/** Parse the decision id out of the routed decision message (no hardcoding). */
function parseDecisionId(bot: HdBot): string {
	const sent = bot.escalations.sentGroups;
	const decisionMsg = sent.find((g) => g.message.title.includes("待人工决策"));
	expect(decisionMsg).toBeDefined();
	const match = decisionMsg!.message.text.match(/D-\d+-[0-9a-f]{4}/);
	expect(match).not.toBeNull();
	return match![0];
}

/** Scan the durable audit dir for the trace carrying a decisionId. */
function findDurableTrace(
	dataRoot: string,
	pipelineId: number,
	decisionId: string,
): Record<string, unknown> | undefined {
	const dir = join(dataRoot, "audit", String(pipelineId));
	if (!existsSync(dir)) return undefined;
	for (const entry of readdirSync(dir)) {
		if (!entry.endsWith("-audit-trace.json")) continue;
		const trace = JSON.parse(readFileSync(join(dir, entry), "utf8"));
		if (trace.decisionId === decisionId) return trace;
	}
	return undefined;
}

describe("e2e human-decision — 验收门（T11）", () => {
	const bots: HdBot[] = [];
	function bot(opts: Parameters<typeof buildBot>[0]): HdBot {
		const b = buildBot(opts);
		bots.push(b);
		return b;
	}
	afterEach(() => {
		for (const b of bots.splice(0)) b.teardown();
	});

	it("1. happy path：decidable → 决策消息含 id+/heal 模板 → /heal test → resume → mr + 审计 + 现场清理", async () => {
		const b = bot({
			repairEnv: REPAIR_ESCALATE_ENV,
			resumeEnv: { CIHEAL_AGENT_MODE: "stub" },
		});
		b.schedulerRepair.enqueue(makeEvent(1));
		await b.schedulerRepair.idle();

		// Routed decision message carries the decision id + copy-paste /heal template.
		const id = parseDecisionId(b);
		const decisionMsg = b.escalations.sentGroups.find(
			(g) => g.message.title.includes("待人工决策"),
		)!;
		expect(decisionMsg.conversationId).toBe(CONV);
		expect(decisionMsg.message.text).toContain(`/heal ${id} test|prod|drop`);

		const record = b.store.get(id)!;
		expect(record.status).toBe("awaiting_decision");
		const sceneCwd = record.cwd_path;
		expect(existsSync(sceneCwd)).toBe(true);

		// Human decides: test, with a spec remark.
		await b.heal(`/heal ${id} test spec says add(2,3) should be 5`);
		expect(b.store.get(id)!.status).toBe("resumed");
		expect(b.store.get(id)!.remark).toBe("spec says add(2,3) should be 5");
		expect(b.enqueueResumeSpy).toHaveBeenCalledTimes(1);
		await b.schedulerResume.idle();

		// Durable audit of the RESUME run carries the decision chain (the scene
		// itself is cleaned by now — the durable copy survives).
		const trace = findDurableTrace(b.dataRoot, 1, id);
		expect(trace).toBeDefined();
		expect(trace!.chainDepth).toBe(1);
		expect(trace!.outcome).toBe("mr");

		// Scene cleaned after the resume (one-round terminal).
		expect(existsSync(sceneCwd)).toBe(false);
	}, 120_000);

	it("2. prod：closed + 现场清理 + 回复，不 spawn resume worker", async () => {
		const b = bot({
			repairEnv: REPAIR_ESCALATE_ENV,
			resumeEnv: { CIHEAL_AGENT_MODE: "stub" },
		});
		const cwd = seedScene(b, "D-2-prod01", makeEvent(2));

		await b.heal("/heal D-2-prod01 prod");

		expect(b.store.get("D-2-prod01")!.status).toBe("closed");
		expect(existsSync(cwd)).toBe(false);
		expect(b.enqueueResumeSpy).not.toHaveBeenCalled();
		const reply = b.replies.sentGroups.at(-1)!;
		expect(reply.message.title).toContain("源码 bug");
	});

	it("3. drop：dropped + 现场清理 + 回复", async () => {
		const b = bot({
			repairEnv: REPAIR_ESCALATE_ENV,
			resumeEnv: { CIHEAL_AGENT_MODE: "stub" },
		});
		const cwd = seedScene(b, "D-3-drop01", makeEvent(3));

		await b.heal("/heal D-3-drop01 drop");

		expect(b.store.get("D-3-drop01")!.status).toBe("dropped");
		expect(existsSync(cwd)).toBe(false);
		expect(b.enqueueResumeSpy).not.toHaveBeenCalled();
		expect(b.replies.sentGroups.at(-1)!.message.title).toContain("已丢弃");
	});

	it("4. TTL 过期：sweep tick 删行 + 清理现场 + 超时通知；此后 /heal 答未找到", async () => {
		const b = bot({
			repairEnv: REPAIR_ESCALATE_ENV,
			resumeEnv: { CIHEAL_AGENT_MODE: "stub" },
		});
		// Seed ALREADY expired (past expires_at): the sweep only cares about
		// the timestamp, so this deterministically drives the TTL path.
		const cwd = seedScene(
			b,
			"D-4-ttl001",
			makeEvent(4),
			new Date(Date.now() - 1000).toISOString(),
		);

		const handle = b.lifecycle.startTtlSweep({ intervalMs: 20 });
		try {
			const deadline = Date.now() + 5000;
			// Sweep deletes the row first, then cleans the scene asynchronously —
			// poll for BOTH so the test never races the cleanup.
			while (
				(b.store.get("D-4-ttl001") || existsSync(cwd)) &&
				Date.now() < deadline
			) {
				await new Promise((r) => setTimeout(r, 20));
			}
		} finally {
			handle.stop();
		}

		expect(b.store.get("D-4-ttl001")).toBeUndefined(); // deleted by design
		expect(existsSync(cwd)).toBe(false);
		const timeout = b.escalations.sentGroups.find((g) =>
			g.message.title.includes("超时"),
		);
		expect(timeout).toBeDefined();
		expect(timeout!.message.text).toContain("D-4-ttl001");

		// /heal afterwards answers 未找到 (the row is gone — document the behavior).
		await b.heal("/heal D-4-ttl001 test");
		const reply = b.replies.sentGroups.at(-1)!;
		expect(reply.message.title).toContain("未找到");
		expect(b.enqueueResumeSpy).not.toHaveBeenCalled();
	});

	it("5. 作废：同项目新 pipeline → 决策作废 + 现场清理 + 通知；新流水线不受影响", async () => {
		const b = bot({
			repairEnv: { CIHEAL_AGENT_MODE: "stub" }, // new pipeline: canned fix → mr
			resumeEnv: { CIHEAL_AGENT_MODE: "stub" },
		});
		const cwd = seedScene(b, "D-5-inv001", makeEvent(5));

		await b.lifecycle.onNewPipeline(makeEvent(6));

		expect(b.store.get("D-5-inv001")!.status).toBe("invalidated");
		expect(existsSync(cwd)).toBe(false);
		const invalidation = b.escalations.sentGroups.find((g) =>
			g.message.title.includes("作废"),
		);
		expect(invalidation).toBeDefined();
		expect(invalidation!.message.text).toContain("D-5-inv001");

		// The new pipeline's own flow is unaffected (runs to an MR outcome).
		expect(b.schedulerRepair.enqueue(makeEvent(6))).toBe("queued");
		await b.schedulerRepair.idle();
		expect(b.schedulerRepair.stats()).toEqual({
			running: 0,
			queued: 0,
			inflight: 0,
		});
	}, 120_000);

	it("6. 二次转交终局：resume 再升级 → 终局通知 + 无新决策行 + 现场清理", async () => {
		const b = bot({
			repairEnv: REPAIR_ESCALATE_ENV,
			resumeEnv: {
				// StubAgentRunner resume: canned src/main fix → G3 re-escalation
				// (same fixture as the T06 G3 e2e; no session discovery involved).
				CIHEAL_AGENT_MODE: "stub",
				CIHEAL_STUB_FIX_KIND: "src-main",
			},
		});
		b.schedulerRepair.enqueue(makeEvent(7));
		await b.schedulerRepair.idle();
		const id = parseDecisionId(b);
		const sceneCwd = b.store.get(id)!.cwd_path;

		await b.heal(`/heal ${id} test`);
		expect(b.store.get(id)!.status).toBe("resumed");
		await b.schedulerResume.idle();

		// ONE routed terminal notification with the human-takeover wording.
		const terminal = b.escalations.sentGroups.filter((g) =>
			g.message.title.includes("二次转交"),
		);
		expect(terminal).toHaveLength(1);
		expect(terminal[0].message.text).toContain("人工介入后仍无法修复");
		expect(terminal[0].message.text).toContain("G3");

		// NO new decision row; the resumed row stays terminal; scene cleaned.
		expect(b.store.listByStatus("awaiting_decision")).toEqual([]);
		expect(b.store.listByProject(PROJECT)).toHaveLength(1);
		expect(b.store.get(id)!.status).toBe("resumed");
		expect(existsSync(sceneCwd)).toBe(false);
	}, 120_000);

	it("7. 命令拒绝：未知 id / 已消费重放 / 私聊 → 有信息量的回复，零状态变更", async () => {
		const b = bot({
			repairEnv: REPAIR_ESCALATE_ENV,
			resumeEnv: { CIHEAL_AGENT_MODE: "stub" },
		});
		const cwd = seedScene(b, "D-7-rej001", makeEvent(7));

		// Unknown id.
		await b.heal("/heal D-nope0000 test");
		expect(b.replies.sentGroups.at(-1)!.message.title).toContain("未找到");

		// Consume the decision, then replay — rejected, still resumed.
		await b.heal("/heal D-7-rej001 drop");
		expect(b.store.get("D-7-rej001")!.status).toBe("dropped");
		await b.heal("/heal D-7-rej001 test");
		const replay = b.replies.sentGroups.at(-1)!;
		expect(replay.message.title).toContain("已处理");
		expect(b.store.get("D-7-rej001")!.status).toBe("dropped");

		// Private chat — group-only command.
		await b.heal("/heal D-7-rej001 test", { conversationType: "private" });
		expect(b.replies.sentGroups.at(-1)!.message.title).toContain("仅支持群聊");
		expect(existsSync(cwd)).toBe(false); // drop already cleaned; nothing re-runs
	});

	it("8. 重启安全：close 后重开同一 db，pending 决策仍在且可 /heal", async () => {
		const b = bot({
			repairEnv: REPAIR_ESCALATE_ENV,
			resumeEnv: { CIHEAL_AGENT_MODE: "stub" },
		});
		seedScene(b, "D-8-rst001", makeEvent(8));

		// Simulate a process restart: close, reopen the SAME db file.
		const dbPath = join(b.dataRoot, "decisions.db");
		b.store.close();
		const reopened = new DecisionStore(dbPath);
		try {
			const record = reopened.get("D-8-rst001");
			expect(record).toBeDefined();
			expect(record!.status).toBe("awaiting_decision");

			// /heal against the reopened store claims the decision.
			const handled = await handleHealCommand(
				{
					store: reopened,
					reply: (cid, msg) => b.replies.sendTo(cid, msg),
					enqueueResume: b.enqueueResumeSpy,
				},
				groupMessage("/heal D-8-rst001 test"),
			);
			expect(handled).toBe(true);
			expect(reopened.get("D-8-rst001")!.status).toBe("resumed");
			expect(b.enqueueResumeSpy).toHaveBeenCalledTimes(1);
		} finally {
			reopened.close();
		}
	});
});
