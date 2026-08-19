import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import type { MetricsEntry, MetricsSnapshot, TrendDay } from "./shared-types.js";

export type { MetricsEntry, MetricsSnapshot, TrendDay } from "./shared-types.js";

interface DailyCounts {
	success: number;
	escalation: number;
	failure: number;
}

const DEFAULT_RECENT_LIMIT = 100;

export class MetricsAggregator {
	private count = 0;
	private successCount = 0;
	private escalationCount = 0;
	private failureCount = 0;
	private totalTokens = 0;
	private totalCost = 0;
	private totalDurationMs = 0;
	private dailyCounts = new Map<string, DailyCounts>();
	private recent: MetricsEntry[] = [];

	private skippedLines = 0;

	async load(auditDir: string): Promise<void> {
		// readdir/readFile catch: audit dir or individual files may not exist
		// on first boot — degrade gracefully to empty metrics.
		const entries = await readdir(auditDir, { withFileTypes: true }).catch(
			() => [],
		);
		for (const e of entries) {
			if (!e.isDirectory()) continue;
			const file = join(auditDir, e.name, "metrics.jsonl");
			const raw = await readFile(file, "utf8").catch(() => "");
			for (const line of raw.split("\n")) {
				if (line.trim() === "") continue;
				try {
					this.ingest(JSON.parse(line) as MetricsEntry);
				} catch {
					this.skippedLines++;
				}
			}
		}
		if (this.skippedLines > 0) {
			console.warn(`[MetricsAggregator] skipped ${this.skippedLines} malformed lines during preload`);
		}
	}

	record(entry: MetricsEntry): void {
		this.ingest(entry);
	}

	snapshot(): MetricsSnapshot {
		const c = this.count;
		return {
			count: c,
			successCount: this.successCount,
			escalationCount: this.escalationCount,
			failureCount: this.failureCount,
			successRate: c > 0 ? this.successCount / c : 0,
			escalationRate: c > 0 ? this.escalationCount / c : 0,
			failureRate: c > 0 ? this.failureCount / c : 0,
			avgDurationMs: c > 0 ? Math.round(this.totalDurationMs / c) : 0,
			totalTokens: this.totalTokens,
			totalCost: this.totalCost,
		};
	}

	recentEntries(limit = DEFAULT_RECENT_LIMIT): MetricsEntry[] {
		const take = Math.min(limit, this.recent.length);
		return this.recent.slice(this.recent.length - take);
	}

	trendData(days = 14): TrendDay[] {
		const result: TrendDay[] = [];
		const today = new Date();
		today.setUTCHours(0, 0, 0, 0);

		for (let i = days - 1; i >= 0; i--) {
			const d = new Date(today);
			d.setUTCDate(d.getUTCDate() - i);
			const date = d.toISOString().slice(0, 10);
			const counts = this.dailyCounts.get(date) ?? { success: 0, escalation: 0, failure: 0 };
			result.push({ date, ...counts });
		}
		return result;
	}

	private ingest(entry: MetricsEntry): void {
		this.count++;
		if (entry.outcome === "mr") this.successCount++;
		else if (entry.outcome === "escalated") this.escalationCount++;
		else if (entry.outcome === "failed") this.failureCount++;
		this.totalTokens += entry.tokens ?? 0;
		this.totalCost += entry.cost ?? 0;
		this.totalDurationMs += entry.durationMs ?? 0;

		this.recent.push(entry);
		if (this.recent.length > DEFAULT_RECENT_LIMIT) {
			this.recent.shift();
		}

		const date = entry.createdAt.slice(0, 10);
		const bucket = this.dailyCounts.get(date) ?? { success: 0, escalation: 0, failure: 0 };
		if (entry.outcome === "mr") bucket.success++;
		else if (entry.outcome === "escalated") bucket.escalation++;
		else if (entry.outcome === "failed") bucket.failure++;
		this.dailyCounts.set(date, bucket);
	}
}
