import { useEffect, useRef, useState } from "react";
import { StatusCard } from "../components/StatusCard.js";
import { ConnectionBadge } from "../components/ConnectionBadge.js";
import { useEventSource, type WorkerState } from "../hooks/useEventSource.js";
import type { ApiStatusResponse, SessionActivityItem, WorkerLogsResponse, WorkerLogLine } from "../types.js";

function formatUptime(seconds: number): string {
	const h = Math.floor(seconds / 3600);
	const m = Math.floor((seconds % 3600) / 60);
	const s = seconds % 60;
	return h > 0 ? `${h}h ${m}m` : m > 0 ? `${m}m ${s}s` : `${s}s`;
}

const LEVEL_COLORS: Record<string, string> = {
	info: "#94a3b8",
	warn: "#f59e0b",
	error: "#ef4444",
	fatal: "#ef4444",
};

const KIND_LABELS: Record<SessionActivityItem["kind"], string> = {
	text: "💬",
	tool_call: "🔧",
	tool_result: "📄",
	user: "👤",
};

/** Sticky-scroll hook: auto-scroll only when user is near the bottom. */
function useStickyScroll(dep: unknown) {
	const ref = useRef<HTMLDivElement>(null);
	const isAtBottom = useRef(true);

	useEffect(() => {
		const el = ref.current;
		if (!el) return;
		const onScroll = () => {
			const threshold = 30;
			isAtBottom.current =
				el.scrollHeight - el.scrollTop - el.clientHeight < threshold;
		};
		el.addEventListener("scroll", onScroll);
		return () => el.removeEventListener("scroll", onScroll);
	}, []);

	useEffect(() => {
		const el = ref.current;
		if (el && isAtBottom.current) el.scrollTop = el.scrollHeight;
	}, [dep]);

	return ref;
}

/** 展开行的日志面板：轮询 /api/workers/:id/logs（worker.log + session 活动流）。 */
function WorkerLogsPanel({ workerId }: { workerId: string }) {
	const [logs, setLogs] = useState<WorkerLogsResponse | null>(null);

	useEffect(() => {
		const load = () =>
			fetch(`/api/workers/${encodeURIComponent(workerId)}/logs`)
				.then((r) => (r.ok ? r.json() : null))
				.then((data: WorkerLogsResponse | null) => {
					if (data) setLogs(data);
				})
				.catch((err) => console.warn("[Dashboard] worker logs fetch failed:", err));
		load();
		const interval = setInterval(load, 2_500);
		return () => clearInterval(interval);
	}, [workerId]);

	const workerLogRef = useStickyScroll(logs?.workerLog);
	const sessionRef = useStickyScroll(logs?.session);

	const paneStyle = {
		background: "#0f172a",
		border: "1px solid #334155",
		borderRadius: 6,
		padding: "0.5rem",
		height: "20rem",
		overflowY: "auto" as const,
		fontFamily: "monospace",
		fontSize: "0.78rem",
		lineHeight: 1.5,
		whiteSpace: "pre-wrap" as const,
		wordBreak: "break-all" as const,
	};

	return (
		<tr>
			<td colSpan={6} style={{ padding: "0.5rem" }}>
				<div style={{ display: "grid", gridTemplateColumns: "1fr 1.4fr", gap: "0.75rem" }}>
					<div>
						<div style={{ color: "#94a3b8", fontSize: "0.8rem", marginBottom: "0.25rem" }}>worker.log（编排层）</div>
						<div ref={workerLogRef} style={paneStyle}>
							{!logs || logs.workerLog.length === 0 ? (
								<span style={{ color: "#64748b" }}>暂无日志</span>
							) : (
								logs.workerLog.map((line: WorkerLogLine, i: number) => (
									<div key={i}>
										<span style={{ color: "#64748b" }}>{line.time.slice(11, 19)} </span>
										<span style={{ color: LEVEL_COLORS[line.level] ?? "#94a3b8" }}>[{line.level}] </span>
										{line.msg}
									</div>
								))
							)}
						</div>
					</div>
					<div>
						<div style={{ color: "#94a3b8", fontSize: "0.8rem", marginBottom: "0.25rem" }}>agent 活动流（session）</div>
						<div ref={sessionRef} style={paneStyle}>
							{!logs || logs.session.length === 0 ? (
								<span style={{ color: "#64748b" }}>暂无活动（agent 尚未产生输出）</span>
							) : (
								logs.session.map((item: SessionActivityItem, i: number) => (
									<div key={i}>
										<span>{KIND_LABELS[item.kind]} </span>
										<span style={{ color: item.kind === "tool_result" ? "#64748b" : "#e2e8f0" }}>
											{item.summary}
										</span>
									</div>
								))
							)}
						</div>
					</div>
				</div>
			</td>
		</tr>
	);
}

function WorkerRow({ w, expanded, onToggle }: { w: WorkerState; expanded: boolean; onToggle: () => void }) {
	return (
		<tr
			onClick={onToggle}
			style={{ borderBottom: "1px solid #334155", cursor: "pointer", background: expanded ? "#1e293b" : undefined }}
		>
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
	const [expandedId, setExpandedId] = useState<string | null>(null);

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
							<>
								<WorkerRow
									key={w.workerId}
									w={w}
									expanded={expandedId === w.workerId}
									onToggle={() => setExpandedId(expandedId === w.workerId ? null : w.workerId)}
								/>
								{expandedId === w.workerId && <WorkerLogsPanel key={`${w.workerId}-logs`} workerId={w.workerId} />}
							</>
						))}
					</tbody>
				</table>
			)}
			<p style={{ color: "#64748b", fontSize: "0.78rem", marginTop: "0.5rem" }}>
				点击 worker 行展开实时日志（worker.log + agent 活动流，2.5s 轮询）
			</p>
		</div>
	);
}
