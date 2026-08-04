/**
 * Metrics aggregator (ticket 07) — reads metrics.jsonl files under the bot
 * work root and prints aggregate stats: success rate, avg repair time,
 * cost per repair, repair count.
 *
 * v1 file-based (G7: no external deps). Evolution seam: ship lines to
 * Prometheus + Grafana instead of reading files.
 *
 * Usage: node scripts/metrics-summary.mjs [workRoot]
 *   workRoot defaults to $CIHEAL_WORK_ROOT or os.tmpdir()/ci-self-heal-work
 */

import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";

const workRoot = process.argv[2] ?? process.env.CIHEAL_WORK_ROOT ?? join(tmpdir(), "ci-self-heal-work");

async function collectLines(root) {
	const entries = await readdir(root, { withFileTypes: true }).catch(() => []);
	const lines = [];
	for (const e of entries) {
		if (!e.isDirectory()) continue;
		const file = join(root, e.name, "metrics.jsonl");
		const raw = await readFile(file, "utf8").catch(() => "");
		for (const l of raw.split("\n")) {
			if (l.trim() === "") continue;
			try {
				lines.push(JSON.parse(l));
			} catch {
				// skip malformed line
			}
		}
	}
	return lines;
}

const lines = await collectLines(workRoot);
if (lines.length === 0) {
	console.log(JSON.stringify({ workRoot, count: 0, note: "no metrics.jsonl found" }, null, 2));
	process.exit(0);
}

const count = lines.length;
const successes = lines.filter((l) => l.outcome === "mr").length;
const escalations = lines.filter((l) => l.outcome === "escalated").length;
const failures = lines.filter((l) => l.outcome === "failed").length;
const totalTokens = lines.reduce((s, l) => s + (l.tokens ?? 0), 0);
const totalCost = lines.reduce((s, l) => s + (l.cost ?? 0), 0);
const totalDuration = lines.reduce((s, l) => s + (l.durationMs ?? 0), 0);

const summary = {
	workRoot,
	count,
	successRate: count > 0 ? successes / count : 0,
	escalationRate: count > 0 ? escalations / count : 0,
	failureRate: count > 0 ? failures / count : 0,
	avgRepairMs: count > 0 ? Math.round(totalDuration / count) : 0,
	totalTokens,
	totalCost,
	avgCostPerRepair: count > 0 ? totalCost / count : 0,
};

console.log(JSON.stringify(summary, null, 2));
