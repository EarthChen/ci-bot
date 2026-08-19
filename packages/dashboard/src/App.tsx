import { BrowserRouter, Routes, Route, NavLink } from "react-router-dom";
import { Overview } from "./pages/Overview.js";
import { Decisions } from "./pages/Decisions.js";
import { Metrics } from "./pages/Metrics.js";

export function App() {
	return (
		<BrowserRouter basename="/dashboard">
			<div style={{ fontFamily: "system-ui, sans-serif", minHeight: "100vh", background: "#0f172a", color: "#e2e8f0" }}>
				<nav style={{ display: "flex", gap: "1rem", padding: "1rem 2rem", borderBottom: "1px solid #1e293b" }}>
					<NavLink to="/" end style={({ isActive }) => ({ color: isActive ? "#38bdf8" : "#94a3b8", textDecoration: "none", fontWeight: 600 })}>
						Overview
					</NavLink>
					<NavLink to="/decisions" style={({ isActive }) => ({ color: isActive ? "#38bdf8" : "#94a3b8", textDecoration: "none", fontWeight: 600 })}>
						Decisions
					</NavLink>
					<NavLink to="/metrics" style={({ isActive }) => ({ color: isActive ? "#38bdf8" : "#94a3b8", textDecoration: "none", fontWeight: 600 })}>
						Metrics
					</NavLink>
				</nav>
				<main style={{ padding: "2rem" }}>
					<Routes>
						<Route path="/" element={<Overview />} />
						<Route path="/decisions" element={<Decisions />} />
						<Route path="/metrics" element={<Metrics />} />
					</Routes>
				</main>
			</div>
		</BrowserRouter>
	);
}
