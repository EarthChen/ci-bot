import type { ConnectionStatus } from "../hooks/useEventSource.js";

const colors: Record<ConnectionStatus, string> = {
	connected: "#22c55e",
	connecting: "#f59e0b",
	disconnected: "#ef4444",
};

export function ConnectionBadge({ status }: { status: ConnectionStatus }) {
	return (
		<div style={{ display: "flex", alignItems: "center", gap: "0.5rem", fontSize: "0.8rem" }}>
			<div style={{
				width: 8,
				height: 8,
				borderRadius: "50%",
				background: colors[status],
			}} />
			<span style={{ color: "#94a3b8" }}>
				{status === "connected" ? "Live" : status === "connecting" ? "Connecting..." : "Disconnected"}
			</span>
		</div>
	);
}
