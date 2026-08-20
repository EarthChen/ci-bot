/**
 * CI log parsers — extract structured violations from raw CI output so the
 * agent can read a compact violations.json instead of grepping 100KB+ logs.
 */

export interface CheckstyleViolation {
	readonly file: string;
	readonly line: number;
	readonly rule: string;
	readonly message: string;
}

export interface SpotbugsViolation {
	readonly file: string;
	readonly line: number;
	readonly bugType: string;
	readonly priority: string;
	readonly message: string;
}

/** Strip GitLab CI absolute prefix to a repo-relative path. */
export function normalizeCiBuildPath(absPath: string): string {
	const trimmed = absPath.trim();
	if (trimmed.startsWith("/builds/")) return trimmed.slice("/builds/".length);
	return trimmed;
}

const CHECKSTYLE_LINE =
	/\[ERROR\]\s+(\S+?):(\d+):\d+:\s*(.+?)\s+\[([^\]]+)\]\s*$/;

/** Parse checkstyle `[ERROR] /builds/.../File.java:line:col: msg [Rule]` lines. */
export function parseCheckstyleViolations(
	ciLog: string,
): CheckstyleViolation[] {
	if (!ciLog) return [];
	const out: CheckstyleViolation[] = [];
	for (const line of ciLog.split("\n")) {
		const m = line.match(CHECKSTYLE_LINE);
		if (!m) continue;
		out.push({
			file: normalizeCiBuildPath(m[1]),
			line: Number(m[2]),
			message: m[3].trim(),
			rule: m[4],
		});
	}
	return out;
}

/** SpotBugs output is highly variable — placeholder until a stable format is pinned. */
export function parseSpotbugsViolations(_ciLog: string): SpotbugsViolation[] {
	return [];
}
