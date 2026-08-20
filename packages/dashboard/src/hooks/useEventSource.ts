import { useEffect, useRef, useState, useCallback } from "react";
import type { SystemSnapshot } from "../types.js";

export type ConnectionStatus = "connecting" | "connected" | "disconnected";

export type { SystemSnapshot } from "../types.js";

export interface WorkerState {
	workerId: string;
	// snapshot 播种/迟到 upsert 时 id 可能尚未随进度到达，允许缺失。
	pipelineId?: number;
	projectId?: string;
	stage?: string;
	turn?: number;
	tokens?: number;
	toolCall?: string;
	startedAt: string;
}

export interface DashboardEvent {
	type: string;
	data: Record<string, unknown>;
}

export function useEventSource(url: string) {
	const [status, setStatus] = useState<ConnectionStatus>("connecting");
	const [snapshot, setSnapshot] = useState<SystemSnapshot>({});
	const [events, setEvents] = useState<DashboardEvent[]>([]);
	const [workers, setWorkers] = useState<Map<string, WorkerState>>(new Map());
	const esRef = useRef<EventSource | null>(null);

	const connect = useCallback(() => {
		const es = new EventSource(url);
		esRef.current = es;

		es.addEventListener("snapshot", (e) => {
			const data = JSON.parse(e.data);
			setSnapshot(data);
			// 迟到客户端从 snapshot 补齐当前活跃 worker（事件是 fire-and-forget，
			// 连上之前发出的收不到）；已有条目不覆盖，避免 snapshot 旧值盖掉新事件。
			if (Array.isArray(data.workers)) {
				setWorkers((prev) => {
					const next = new Map(prev);
					for (const w of data.workers as Array<Record<string, unknown>>) {
						const id = w.workerId;
						if (typeof id !== "string" || next.has(id)) continue;
						next.set(id, {
							workerId: id,
							pipelineId: typeof w.pipelineId === "number" ? w.pipelineId : undefined,
							projectId: typeof w.projectId === "string" ? w.projectId : undefined,
							stage: typeof w.stage === "string" ? w.stage : undefined,
							turn: typeof w.turn === "number" ? w.turn : undefined,
							tokens: typeof w.tokens === "number" ? w.tokens : undefined,
							toolCall: typeof w.toolCall === "string" ? w.toolCall : undefined,
							startedAt: typeof w.startedAt === "string" ? w.startedAt : new Date().toISOString(),
						});
					}
					return next;
				});
			}
			setStatus("connected");
		});

		es.addEventListener("worker_started", (e) => {
			const data = JSON.parse(e.data);
			setWorkers((prev) => {
				const next = new Map(prev);
				next.set(data.workerId, {
					workerId: data.workerId,
					pipelineId: data.pipelineId,
					projectId: data.projectId,
					startedAt: new Date().toISOString(),
				});
				return next;
			});
		});

		es.addEventListener("worker_progress", (e) => {
			const data = JSON.parse(e.data);
			setWorkers((prev) => {
				const next = new Map(prev);
				const existing = next.get(data.workerId);
				// upsert：迟到客户端 missed worker_started 时，首个进度事件也要建条目。
				next.set(data.workerId, {
					workerId: data.workerId,
					startedAt: new Date().toISOString(),
					...existing,
					...data,
				});
				return next;
			});
		});

		es.addEventListener("worker_done", (e) => {
			const data = JSON.parse(e.data);
			setWorkers((prev) => {
				const next = new Map(prev);
				next.delete(data.workerId);
				return next;
			});
			setEvents((prev) => [...prev.slice(-99), { type: "worker_done", data }]);
		});

		es.addEventListener("pipeline_enqueued", (e) => {
			const data = JSON.parse(e.data);
			setEvents((prev) => [...prev.slice(-99), { type: "pipeline_enqueued", data }]);
		});

		es.addEventListener("decision_created", (e) => {
			const data = JSON.parse(e.data);
			setEvents((prev) => [...prev.slice(-99), { type: "decision_created", data }]);
		});

		es.addEventListener("decision_resolved", (e) => {
			const data = JSON.parse(e.data);
			setEvents((prev) => [...prev.slice(-99), { type: "decision_resolved", data }]);
		});

		es.onopen = () => setStatus("connected");
		es.onerror = () => setStatus("disconnected");
	}, [url]);

	useEffect(() => {
		connect();
		return () => {
			esRef.current?.close();
		};
	}, [connect]);

	return { status, snapshot, events, workers };
}
