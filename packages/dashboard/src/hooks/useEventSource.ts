import { useEffect, useRef, useState, useCallback } from "react";
import type { SystemSnapshot } from "../types.js";

export type ConnectionStatus = "connecting" | "connected" | "disconnected";

export type { SystemSnapshot } from "../types.js";

export interface WorkerState {
	workerId: string;
	pipelineId: number;
	projectId: string;
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
				if (existing) {
					next.set(data.workerId, { ...existing, ...data });
				}
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
