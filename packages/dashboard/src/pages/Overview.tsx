import { useEffect, useState } from "react";
import { StatusCard } from "../components/StatusCard.js";
import { ConnectionBadge } from "../components/ConnectionBadge.js";
import { useEventSource, type WorkerState } from "../hooks/useEventSource.js";
import type { ApiStatusResponse } from "../types.js";

function formatUptime(seconds: number): string {
	const h = Math.floor(seconds / 3600);
	const m = Math.floor((seconds % 3600) / 60);
	const s = seconds % 60;
	return h > 0 ? `${h}h ${m}m` : m > 0 ? `${m}m ${s}s` : `${s}s`;
}

function WorkerRow({ w }: { w: WorkerState }) {
	return (
		<tr style={{ borderBottom: "1px solid #334155" }}>
			<td style={{ padding: "0.5rem" }}>{w.projectId}</td>
			<td style={{ padding: "0.5rem" }}>{w.pipelineId}</td>
			<td style={{ padding: "0.5rem" }}>
				<span style={{ background: "#1e40af", padding: "2px 8px", borderRadius: 4, fontSize: "0.8rem" }}>
					{w.stage ?? "starting"}
				</span>
			</td>
			<td style={{ padding: "0.5rem" }}>{w.turn ?? "-"}</td>
			<td style={{ padding: "0.5rem" }}>{w.tokens ?? "-"}</td>
			<td style={{ padding: "0.5rem", color: "#94a3b8", fontSize: "0.8rem" }}>{w.toolCall ?? "-"}</td>
		</tr>
	);
}

export function Overview() {
	const { status, snapshot, workers } = useEventSource("/api/events");
	const [apiStatus, setApiStatus] = useState<ApiStatusResponse | null>(null);

	useEffect(() => {
		const load = () =>
			fetch("/api/status")
				.then((r) => r.json())
				.then((data: ApiStatusResponse) => setApiStatus(data))
				.catch((err) => console.warn("[Dashboard] /api/status fetch failed:", err));
		load();
		const interval = setInterval(load, 10_000);
		return () => clearInterval(interval);
	}, []);

	const health = apiStatus?.health ?? snapshot.health;
	const sched = apiStatus?.scheduler ?? snapshot.scheduler;

	return (
		<div>
			<div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: "1.5rem" }}>
				<h1 style={{ fontSize: "1.5rem", margin: 0 }}>CI Self-Heal Dashboard</h1>
				<ConnectionBadge status={status} />
			</div>

			<div style={{ display: "flex", gap: "1rem", flexWrap: "wrap", marginBottom: "2rem" }}>
				<StatusCard label="Uptime" value={health ? formatUptime(health.uptimeSeconds) : "-"} />
				<StatusCard label="Memory" value={health ? `${health.memoryMB} MB` : "-"} />
				<StatusCard label="Version" value={health?.version ?? "-"} color="#94a3b8" />
				<StatusCard label="Running" value={sched?.running ?? 0} color={(sched?.running ?? 0) > 0 ? "#22c55e" : "#94a3b8"} />
				<StatusCard label="Queued" value={sched?.queued ?? 0} color={(sched?.queued ?? 0) > 0 ? "#f59e0b" : "#94a3b8"} />
				<StatusCard label="In-flight" value={sched?.inflight ?? 0} />
			</div>

			<h2 style={{ fontSize: "1.1rem", marginBottom: "0.75rem" }}>Active Workers</h2>
			{workers.size === 0 ? (
				<p style={{ color: "#64748b" }}>No active workers.</p>
			) : (
				<table style={{ width: "100%", borderCollapse: "collapse", fontSize: "0.9rem" }}>
					<thead>
						<tr style={{ borderBottom: "2px solid #334155", textAlign: "left" }}>
							<th style={{ padding: "0.5rem", color: "#94a3b8" }}>Project</th>
							<th style={{ padding: "0.5rem", color: "#94a3b8" }}>Pipeline</th>
							<th style={{ padding: "0.5rem", color: "#94a3b8" }}>Stage</th>
							<th style={{ padding: "0.5rem", color: "#94a3b8" }}>Turn</th>
							<th style={{ padding: "0.5rem", color: "#94a3b8" }}>Tokens</th>
							<th style={{ padding: "0.5rem", color: "#94a3b8" }}>Last Tool</th>
						</tr>
					</thead>
					<tbody>
						{Array.from(workers.values()).map((w) => (
							<WorkerRow key={w.workerId} w={w} />
						))}
					</tbody>
				</table>
			)}
		</div>
	);
}
