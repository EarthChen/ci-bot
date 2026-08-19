export type WorkerIpcMessage =
	| { type: "stage_enter"; stage: string; pipelineId: number; projectId: string }
	| { type: "stage_exit"; stage: string }
	| { type: "turn_start"; turn: number }
	| { type: "turn_end"; turn: number; tokens: number; cost: number }
	| { type: "tool_call"; name: string; summary: string }
	| { type: "metrics_record"; projectId: string; pipelineId: number; outcome: string; turns: number; tokens: number; cost: number; durationMs: number; createdAt: string };

export function isWorkerIpcMessage(msg: unknown): msg is WorkerIpcMessage {
	if (typeof msg !== "object" || msg === null) return false;
	const m = msg as Record<string, unknown>;
	switch (m.type) {
		case "stage_enter":
			return typeof m.stage === "string" && typeof m.pipelineId === "number" && typeof m.projectId === "string";
		case "stage_exit":
			return typeof m.stage === "string";
		case "turn_start":
			return typeof m.turn === "number";
		case "turn_end":
			return typeof m.turn === "number" && typeof m.tokens === "number" && typeof m.cost === "number";
		case "tool_call":
			return typeof m.name === "string" && typeof m.summary === "string";
		case "metrics_record":
			return (
				typeof m.projectId === "string" &&
				typeof m.pipelineId === "number" &&
				typeof m.outcome === "string" &&
				typeof m.turns === "number" &&
				typeof m.tokens === "number" &&
				typeof m.cost === "number" &&
				typeof m.durationMs === "number" &&
				typeof m.createdAt === "string"
			);
		default:
			return false;
	}
}

/**
 * Send an IPC message to the main process. Fires only in worker
 * subprocesses whose IPC channel the bot actually wired: the manager sets
 * CIHEAL_WORKER_IPC=1 in the child env exactly when it spawns with an ipc
 * stdio + onIpcMessage. Gating on this explicit flag (not on process.send
 * presence) keeps foreign channels untouched — vitest's forks pool exposes
 * process.send on its own tinypool channel, and our envelope breaks its
 * deserialize protocol (OOM'd the fork: tests/worker/entry-dispatch).
 */
export function sendIpc(msg: WorkerIpcMessage): void {
	if (process.env.CIHEAL_WORKER_IPC !== "1") return;
	if (typeof process.send !== "function") return;
	process.send(msg);
}
