import type { AgentSession } from "@earendil-works/pi-coding-agent";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { sendIpc } from "../dashboard/ipc-types.js";
import { logger } from "../util/log.js";
import type { SupersedePayload } from "./control-types.js";
import { buildSupersedeSteerText } from "./steer-text.js";

type SteerCapableSession = Pick<
	AgentSession,
	"steer" | "clearQueue" | "subscribe"
>;

interface SteerSessionState {
	readonly session: SteerCapableSession;
	pendingUndelivered: boolean;
	unsubscribe?: () => void;
}

let activeSteerSession: SteerSessionState | undefined;
let pendingSupersedePayload: SupersedePayload | undefined;

/** Register the live agent session for supersede steer (worker-local). */
export function registerSteerSession(session: SteerCapableSession): () => void {
	if (activeSteerSession) {
		activeSteerSession.unsubscribe?.();
	}
	const state: SteerSessionState = { session, pendingUndelivered: false };
	state.unsubscribe = session.subscribe((event) => {
		if (event.type !== "queue_update") return;
		const steering = event.steering;
		if (state.pendingUndelivered && steering.length === 0) {
			markSteerDelivered(state);
		}
	});
	activeSteerSession = state;
	if (pendingSupersedePayload) {
		const payload = pendingSupersedePayload;
		pendingSupersedePayload = undefined;
		void deliverSupersedeSteer(state, payload);
	}
	return () => clearSteerSession();
}

export function clearSteerSession(): void {
	if (!activeSteerSession) return;
	activeSteerSession.unsubscribe?.();
	activeSteerSession = undefined;
	pendingSupersedePayload = undefined;
}

function markSteerDelivered(state: SteerSessionState): void {
	state.pendingUndelivered = false;
	sendIpc({ type: "steer_delivered" });
}

/** Apply one supersede payload to the active session (merge undelivered steers). */
export async function applySupersedeSteer(payload: SupersedePayload): Promise<void> {
	const state = activeSteerSession;
	if (!state) {
		pendingSupersedePayload = mergePendingSupersede(pendingSupersedePayload, payload);
		logger.info(
			{ newSha: payload.newSha, newPipelineId: payload.newPipelineId },
			"supersede steer queued until session opens",
		);
		return;
	}
	await deliverSupersedeSteer(state, payload);
}

function mergePendingSupersede(
	current: SupersedePayload | undefined,
	incoming: SupersedePayload,
): SupersedePayload {
	if (!current) return incoming;
	return {
		oldSha: current.oldSha,
		newSha: incoming.newSha,
		newPipelineId: incoming.newPipelineId,
		...(incoming.changedFiles?.length
			? { changedFiles: incoming.changedFiles }
			: current.changedFiles?.length
				? { changedFiles: current.changedFiles }
				: {}),
		...(incoming.greenStatus ? { greenStatus: true } : current.greenStatus ? { greenStatus: true } : {}),
	};
}

async function deliverSupersedeSteer(
	state: SteerSessionState,
	payload: SupersedePayload,
): Promise<void> {
	const text = buildSupersedeSteerText(payload);
	const replacing = state.pendingUndelivered;
	if (replacing) {
		await state.session.clearQueue();
	}
	await state.session.steer(text);
	state.pendingUndelivered = true;
	recordSteerAudit(text, replacing);
	sendIpc({
		type: "steer_queued",
		newSha: payload.newSha,
		newPipelineId: payload.newPipelineId,
	});
}

function resolveWorkerCwd(): string | undefined {
	const taskJson = process.env.CIHEAL_WORKER_TASK;
	if (!taskJson) return undefined;
	try {
		const task = JSON.parse(taskJson) as { cwd?: string };
		return typeof task.cwd === "string" ? task.cwd : undefined;
	} catch {
		return undefined;
	}
}

/** Worker-local audit sidecar for e2e + ops (merge window keeps latest only). */
function recordSteerAudit(text: string, merged: boolean): void {
	const cwd = resolveWorkerCwd();
	if (!cwd) return;
	const path = join(cwd, "steers.json");
	let steers: string[] = [];
	if (!merged) {
		try {
			const parsed = JSON.parse(readFileSync(path, "utf8")) as unknown;
			if (Array.isArray(parsed) && parsed.every((s) => typeof s === "string")) {
				steers = parsed as string[];
			}
		} catch {
			void 0;
		}
	}
	const next = merged ? [text] : [...steers, text];
	mkdirSync(dirname(path), { recursive: true });
	writeFileSync(path, JSON.stringify(next, null, 2), "utf8");
}
