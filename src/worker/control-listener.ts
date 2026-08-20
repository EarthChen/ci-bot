import { logger } from "../util/log.js";
import { sendIpc } from "../dashboard/ipc-types.js";
import { isSupersedePayload, isWorkerControlMessage } from "./control-types.js";
import { applySupersedeSteer } from "./steer-session.js";

/** Handle one main→worker control message (test seam + listener delegate). */
export function handleWorkerControlMessage(msg: unknown): void {
	if (process.env.CIHEAL_WORKER_IPC !== "1") return;
	if (!isWorkerControlMessage(msg)) return;
	logger.info({ control: msg }, "worker control message received");
	if (msg.type === "supersede" && isSupersedePayload(msg.payload)) {
		void applySupersedeSteer(msg.payload).catch((err) => {
			logger.warn({ err, control: msg }, "supersede steer apply failed");
		});
	}
	sendIpc({ type: "control_ack", controlType: msg.type });
}

/**
 * Listen for main→worker control messages on the shared IPC channel.
 * Gated on CIHEAL_WORKER_IPC (same contract as sendIpc).
 * Returns uninstall — worker must drop the listener before exit or the
 * process stays alive on the open IPC handle.
 */
export function installWorkerControlListener(): () => void {
	if (process.env.CIHEAL_WORKER_IPC !== "1") return () => {};
	const handler = handleWorkerControlMessage;
	process.on("message", handler);
	return () => process.off("message", handler);
}
