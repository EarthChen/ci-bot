/** Supersede steer payload (main→worker, ticket 06). */
export interface SupersedePayload {
	readonly oldSha: string;
	readonly newSha: string;
	readonly newPipelineId: number;
	/** 变更文件清单（可选，由 glab diff 提供）。 */
	readonly changedFiles?: readonly string[];
	/** 新 pipeline 已绿时为 true。 */
	readonly greenStatus?: boolean;
}

/** 主进程→worker 的控制消息（反向 IPC）。 */
export type WorkerControlMessage =
	| { type: "supersede"; payload: SupersedePayload };

export function isSupersedePayload(value: unknown): value is SupersedePayload {
	if (typeof value !== "object" || value === null) return false;
	const p = value as Record<string, unknown>;
	if (typeof p.oldSha !== "string" || p.oldSha.length === 0) return false;
	if (typeof p.newSha !== "string" || p.newSha.length === 0) return false;
	if (typeof p.newPipelineId !== "number" || !Number.isFinite(p.newPipelineId)) {
		return false;
	}
	if (p.changedFiles !== undefined) {
		if (
			!Array.isArray(p.changedFiles) ||
			!p.changedFiles.every((f) => typeof f === "string")
		) {
			return false;
		}
	}
	if (p.greenStatus !== undefined && typeof p.greenStatus !== "boolean") {
		return false;
	}
	return true;
}

export function isWorkerControlMessage(msg: unknown): msg is WorkerControlMessage {
	if (typeof msg !== "object" || msg === null) return false;
	const m = msg as Record<string, unknown>;
	switch (m.type) {
		case "supersede":
			return isSupersedePayload(m.payload);
		default:
			return false;
	}
}
