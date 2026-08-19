interface Props {
	label: string;
	value: string | number;
	color?: string;
}

export function StatusCard({ label, value, color = "#38bdf8" }: Props) {
	return (
		<div style={{
			background: "#1e293b",
			borderRadius: "8px",
			padding: "1.25rem",
			minWidth: "140px",
		}}>
			<div style={{ color: "#94a3b8", fontSize: "0.75rem", textTransform: "uppercase", letterSpacing: "0.05em" }}>
				{label}
			</div>
			<div style={{ color, fontSize: "1.75rem", fontWeight: 700, marginTop: "0.25rem" }}>
				{value}
			</div>
		</div>
	);
}
