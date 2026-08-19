import { useEffect, useState } from "react";
import { StatusCard } from "../components/StatusCard.js";
import type { MetricsApiResponse, MetricsEntry, TrendData } from "../types.js";

function formatDuration(ms: number): string {
	if (ms === 0) return "-";
	const s = Math.round(ms / 1000);
	const m = Math.floor(s / 60);
	return m > 0 ? `${m}m ${s % 60}s` : `${s}s`;
}

function formatTokens(n: number): string {
	if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
	if (n >= 1_000) return `${(n / 1_000).toFixed(1)}K`;
	return String(n);
}

function formatOutcome(outcome: string): string {
	if (outcome === "mr") return "success";
	if (outcome === "escalated") return "escalation";
	if (outcome === "failed") return "failure";
	return outcome;
}

const outcomeColors: Record<string, string> = {
	mr: "#22c55e",
	escalated: "#f59e0b",
	failed: "#ef4444",
};

function Bar({ label, value, max, color }: { label: string; value: number; max: number; color: string }) {
	const pct = max > 0 ? (value / max) * 100 : 0;
	return (
		<div style={{ marginBottom: "0.75rem" }}>
			<div style={{ display: "flex", justifyContent: "space-between", fontSize: "0.85rem", marginBottom: "0.25rem" }}>
				<span style={{ color: "#e2e8f0" }}>{label}</span>
				<span style={{ color: "#94a3b8" }}>{value}</span>
			</div>
			<div style={{ background: "#1e293b", borderRadius: 4, height: 8, overflow: "hidden" }}>
				<div style={{ width: `${pct}%`, height: "100%", background: color, borderRadius: 4, transition: "width 0.3s" }} />
			</div>
		</div>
	);
}

function DailyTrendBar({ date, success, escalation, failure, max }: {
	date: string;
	success: number;
	escalation: number;
	failure: number;
	max: number;
}) {
	const total = success + escalation + failure;
	const pct = max > 0 ? (total / max) * 100 : 0;
	const successPct = total > 0 ? (success / total) * 100 : 0;
	const escalationPct = total > 0 ? (escalation / total) * 100 : 0;
	const failurePct = total > 0 ? (failure / total) * 100 : 0;

	return (
		<div style={{ marginBottom: "0.5rem" }}>
			<div style={{ display: "flex", justifyContent: "space-between", fontSize: "0.8rem", marginBottom: "0.2rem" }}>
				<span style={{ color: "#94a3b8" }}>{date.slice(5)}</span>
				<span style={{ color: "#64748b" }}>{total}</span>
			</div>
			<div style={{ background: "#1e293b", borderRadius: 4, height: 10, overflow: "hidden", width: `${Math.max(pct, total > 0 ? 4 : 0)}%`, minWidth: total > 0 ? 24 : 0, display: "flex" }}>
				{success > 0 && <div style={{ width: `${successPct}%`, height: "100%", background: "#22c55e" }} />}
				{escalation > 0 && <div style={{ width: `${escalationPct}%`, height: "100%", background: "#f59e0b" }} />}
				{failure > 0 && <div style={{ width: `${failurePct}%`, height: "100%", background: "#ef4444" }} />}
			</div>
		</div>
	);
}

function RecentRepairRow({ entry, maxDurationMs }: { entry: MetricsEntry; maxDurationMs: number }) {
	const pct = maxDurationMs > 0 ? (entry.durationMs / maxDurationMs) * 100 : 0;
	const color = outcomeColors[entry.outcome] ?? "#94a3b8";
	const time = new Date(entry.createdAt).toLocaleString(undefined, {
		month: "short",
		day: "numeric",
		hour: "2-digit",
		minute: "2-digit",
	});

	return (
		<div style={{ marginBottom: "0.5rem" }}>
			<div style={{ display: "grid", gridTemplateColumns: "8rem 1fr 5rem 4rem", gap: "0.75rem", alignItems: "center", fontSize: "0.8rem", marginBottom: "0.2rem" }}>
				<span style={{ color: "#94a3b8" }}>{time}</span>
				<span style={{ color: "#e2e8f0", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{entry.projectId}</span>
				<span style={{ color, textTransform: "capitalize" }}>{formatOutcome(entry.outcome)}</span>
				<span style={{ color: "#64748b", textAlign: "right" }}>{formatDuration(entry.durationMs)}</span>
			</div>
			<div style={{ background: "#1e293b", borderRadius: 4, height: 6, overflow: "hidden" }}>
				<div style={{ width: `${Math.max(pct, 2)}%`, height: "100%", background: color, borderRadius: 4 }} />
			</div>
		</div>
	);
}

export function Metrics() {
	const [metrics, setMetrics] = useState<MetricsApiResponse | null>(null);
	const [trend, setTrend] = useState<TrendData | null>(null);

	useEffect(() => {
		const loadMetrics = () =>
			fetch("/api/metrics")
				.then((r) => r.json())
				.then((data: MetricsApiResponse) => setMetrics(data))
				.catch((err) => console.warn("[Dashboard] /api/metrics fetch failed:", err));
		const loadTrend = () =>
			fetch("/api/metrics/trend")
				.then((r) => r.json())
				.then((data: TrendData) => setTrend(data))
				.catch((err) => console.warn("[Dashboard] /api/metrics/trend fetch failed:", err));
		loadMetrics();
		loadTrend();
		const interval = setInterval(() => {
			loadMetrics();
			loadTrend();
		}, 30_000);
		return () => clearInterval(interval);
	}, []);

	if (!metrics) {
		return (
			<div>
				<h1 style={{ fontSize: "1.5rem", marginBottom: "1rem" }}>Metrics</h1>
				<p style={{ color: "#64748b" }}>Loading metrics...</p>
			</div>
		);
	}

	const trendMax = trend
		? Math.max(...trend.map((d) => d.success + d.escalation + d.failure), 1)
		: 1;

	const recentMaxDuration = metrics.recent.length > 0
		? Math.max(...metrics.recent.map((e) => e.durationMs))
		: 1;

	return (
		<div>
			<h1 style={{ fontSize: "1.5rem", marginBottom: "1.5rem" }}>Metrics</h1>

			<div style={{ display: "flex", gap: "1rem", flexWrap: "wrap", marginBottom: "2rem" }}>
				<StatusCard label="Total Repairs" value={metrics.count} />
				<StatusCard label="Success Rate" value={`${(metrics.successRate * 100).toFixed(0)}%`} color="#22c55e" />
				<StatusCard label="Escalation Rate" value={`${(metrics.escalationRate * 100).toFixed(0)}%`} color="#f59e0b" />
				<StatusCard label="Avg Duration" value={formatDuration(metrics.avgDurationMs)} color="#94a3b8" />
				<StatusCard label="Total Tokens" value={formatTokens(metrics.totalTokens)} />
				<StatusCard label="Total Cost" value={`$${metrics.totalCost.toFixed(2)}`} color="#94a3b8" />
			</div>

			<h2 style={{ fontSize: "1.1rem", marginBottom: "0.75rem" }}>Outcome Distribution</h2>
			<div style={{ maxWidth: 500, marginBottom: "2rem" }}>
				<Bar label="Success (MR opened)" value={metrics.successCount} max={metrics.count} color="#22c55e" />
				<Bar label="Escalation (human decision)" value={metrics.escalationCount} max={metrics.count} color="#f59e0b" />
				<Bar label="Failure" value={metrics.failureCount} max={metrics.count} color="#ef4444" />
			</div>

			{metrics.recent.length > 0 && (
				<>
					<h2 style={{ fontSize: "1.1rem", marginBottom: "0.75rem" }}>Recent Repairs</h2>
					<div style={{ maxWidth: 640, marginBottom: "2rem" }}>
						<div style={{ display: "grid", gridTemplateColumns: "8rem 1fr 5rem 4rem", gap: "0.75rem", fontSize: "0.75rem", color: "#64748b", marginBottom: "0.5rem", paddingBottom: "0.25rem", borderBottom: "1px solid #334155" }}>
							<span>Time</span>
							<span>Project</span>
							<span>Result</span>
							<span style={{ textAlign: "right" }}>Duration</span>
						</div>
						{[...metrics.recent].reverse().map((entry) => (
							<RecentRepairRow
								key={`${entry.pipelineId}-${entry.createdAt}`}
								entry={entry}
								maxDurationMs={recentMaxDuration}
							/>
						))}
					</div>
				</>
			)}

			{trend && trend.length > 0 && (
				<>
					<h2 style={{ fontSize: "1.1rem", marginBottom: "0.75rem" }}>Daily Trend (14 days)</h2>
					<div style={{ maxWidth: 500 }}>
						<div style={{ display: "flex", gap: "1rem", fontSize: "0.75rem", color: "#94a3b8", marginBottom: "0.75rem" }}>
							<span><span style={{ color: "#22c55e" }}>■</span> Success</span>
							<span><span style={{ color: "#f59e0b" }}>■</span> Escalation</span>
							<span><span style={{ color: "#ef4444" }}>■</span> Failure</span>
						</div>
						{trend.map((d) => (
							<DailyTrendBar
								key={d.date}
								date={d.date}
								success={d.success}
								escalation={d.escalation}
								failure={d.failure}
								max={trendMax}
							/>
						))}
					</div>
				</>
			)}
		</div>
	);
}
