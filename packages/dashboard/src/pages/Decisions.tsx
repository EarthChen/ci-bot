import { useEffect, useState } from "react";
import type { DecisionSummary } from "../types.js";

function timeUntil(isoDate: string): string {
	const diff = new Date(isoDate).getTime() - Date.now();
	if (diff <= 0) return "expired";
	const hours = Math.floor(diff / 3_600_000);
	const mins = Math.floor((diff % 3_600_000) / 60_000);
	return hours > 0 ? `${hours}h ${mins}m` : `${mins}m`;
}

const statusColors: Record<string, string> = {
	awaiting_decision: "#f59e0b",
	resumed: "#22c55e",
	closed: "#94a3b8",
	dropped: "#94a3b8",
	expired: "#ef4444",
	invalidated: "#94a3b8",
};

export function Decisions() {
	const [decisions, setDecisions] = useState<DecisionSummary[]>([]);
	const [, setTick] = useState(0);

	useEffect(() => {
		const load = () =>
			fetch("/api/decisions")
				.then((r) => r.json())
				.then(setDecisions)
				.catch((err) => console.warn("[Dashboard] /api/decisions fetch failed:", err));
		load();
		const interval = setInterval(load, 15_000);
		return () => clearInterval(interval);
	}, []);

	useEffect(() => {
		const timer = setInterval(() => setTick((t) => t + 1), 30_000);
		return () => clearInterval(timer);
	}, []);

	const awaiting = decisions.filter((d) => d.status === "awaiting_decision");
	const history = decisions.filter((d) => d.status !== "awaiting_decision");

	return (
		<div>
			<h1 style={{ fontSize: "1.5rem", marginBottom: "1.5rem" }}>Decisions</h1>

			<h2 style={{ fontSize: "1.1rem", color: "#f59e0b", marginBottom: "0.75rem" }}>
				Pending ({awaiting.length})
			</h2>
			{awaiting.length === 0 ? (
				<p style={{ color: "#64748b", marginBottom: "2rem" }}>No pending decisions.</p>
			) : (
				<div style={{ display: "flex", flexDirection: "column", gap: "0.75rem", marginBottom: "2rem" }}>
					{awaiting.map((d) => (
						<div key={d.decision_id} style={{ background: "#1e293b", borderRadius: 8, padding: "1rem", borderLeft: "4px solid #f59e0b" }}>
							<div style={{ display: "flex", justifyContent: "space-between", marginBottom: "0.5rem" }}>
								<span style={{ fontWeight: 600 }}>{d.decision_id}</span>
								<span style={{ color: "#f59e0b", fontSize: "0.85rem" }}>
									Expires in {timeUntil(d.expires_at)}
								</span>
							</div>
							<div style={{ fontSize: "0.85rem", color: "#94a3b8" }}>
								Project: {d.project_id} | Pipeline: {d.pipeline_id}
							</div>
							<div style={{ marginTop: "0.5rem", fontFamily: "monospace", fontSize: "0.8rem", color: "#38bdf8", background: "#0f172a", padding: "0.5rem", borderRadius: 4 }}>
								/heal {d.decision_id} test|prod|drop|widen
							</div>
						</div>
					))}
				</div>
			)}

			<h2 style={{ fontSize: "1.1rem", marginBottom: "0.75rem" }}>History ({history.length})</h2>
			{history.length === 0 ? (
				<p style={{ color: "#64748b" }}>No historical decisions.</p>
			) : (
				<table style={{ width: "100%", borderCollapse: "collapse", fontSize: "0.85rem" }}>
					<thead>
						<tr style={{ borderBottom: "2px solid #334155", textAlign: "left" }}>
							<th style={{ padding: "0.5rem", color: "#94a3b8" }}>ID</th>
							<th style={{ padding: "0.5rem", color: "#94a3b8" }}>Project</th>
							<th style={{ padding: "0.5rem", color: "#94a3b8" }}>Status</th>
							<th style={{ padding: "0.5rem", color: "#94a3b8" }}>Decision</th>
							<th style={{ padding: "0.5rem", color: "#94a3b8" }}>Decided By</th>
							<th style={{ padding: "0.5rem", color: "#94a3b8" }}>Date</th>
						</tr>
					</thead>
					<tbody>
						{history.map((d) => (
							<tr key={d.decision_id} style={{ borderBottom: "1px solid #1e293b" }}>
								<td style={{ padding: "0.5rem" }}>{d.decision_id}</td>
								<td style={{ padding: "0.5rem" }}>{d.project_id}</td>
								<td style={{ padding: "0.5rem" }}>
									<span style={{ color: statusColors[d.status] ?? "#94a3b8" }}>{d.status}</span>
								</td>
								<td style={{ padding: "0.5rem" }}>{d.decision_value ?? "-"}</td>
								<td style={{ padding: "0.5rem" }}>{d.decided_by ?? "-"}</td>
								<td style={{ padding: "0.5rem", color: "#64748b" }}>
									{d.decided_at ? new Date(d.decided_at).toLocaleString() : "-"}
								</td>
							</tr>
						))}
					</tbody>
				</table>
			)}
		</div>
	);
}
