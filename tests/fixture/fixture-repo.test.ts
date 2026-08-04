/**
 * Fixture repo test (ticket 08): the local Java/Maven fixture must exist with
 * the right structure and three deliberately-broken branches.
 *
 * The fixture is the substrate for dry-run mode (real mvn test against a
 * safe local repo) and for local debugging. It must be a real git repo with
 * history (so pipeline ref/sha semantics work) and a real pom.xml (so mvn
 * test actually runs).
 *
 * The WHY:
 *  - Without a real pom.xml + .git, dry-run can't run mvn test or simulate
 *    pipeline refs — the whole point of the fixture is to exercise the real
 *    toolchain locally without touching a real GitLab.
 *  - The three branches encode the G1 classes the bot must handle; if a
 *    branch drifts (e.g. someone "fixes" the fixture), the dry-run no longer
 *    exercises the failure the bot is meant to repair.
 */

import { describe, it, expect } from "vitest";
import { stat } from "node:fs/promises";
import { join } from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";

const exec = promisify(execFile);
const FIXTURE = join(process.cwd(), "fixtures", "repo");

describe("fixture repo (ticket 08)", () => {
	it("is a real git repo with history", async () => {
		// --all: the three failure branches are separate commit trees; the
		// healthy baseline is on master. Count across all refs.
		const { stdout } = await exec("git", ["log", "--all", "--oneline"], {
			cwd: FIXTURE,
		});
		const commits = stdout.trim().split("\n").filter(Boolean);
		expect(commits.length).toBeGreaterThanOrEqual(4);
	});

	it("has the Maven project structure (pom.xml + Calculator + CalculatorTest + spec)", async () => {
		await expect(stat(join(FIXTURE, "pom.xml"))).resolves.toBeTruthy();
		await expect(
			stat(join(FIXTURE, "src/main/java/com/example/Calculator.java")),
		).resolves.toBeTruthy();
		await expect(
			stat(join(FIXTURE, "src/test/java/com/example/CalculatorTest.java")),
		).resolves.toBeTruthy();
		await expect(
			stat(join(FIXTURE, "docs/spec/calculator.md")),
		).resolves.toBeTruthy();
	});

	it("has the three failure branches (class 1/2/3)", async () => {
		const { stdout } = await exec("git", ["branch", "-a"], { cwd: FIXTURE });
		const branches = stdout;
		expect(branches).toContain("class1-failing-test");
		expect(branches).toContain("class2-stale-test");
		expect(branches).toContain("class3-missing-test");
	});

	it("class1 branch has a wrong assertion (add(2,3)==4)", async () => {
		// The checked-out branch is master (healthy). Read the class1 branch file.
		const { stdout } = await exec(
			"git",
			["show", "class1-failing-test:src/test/java/com/example/CalculatorTest.java"],
			{ cwd: FIXTURE },
		);
		expect(stdout).toContain("assertEquals(4");
		expect(stdout).not.toContain("assertEquals(5");
	});

	it("class2 branch has production change (add -> multiply)", async () => {
		const { stdout } = await exec(
			"git",
			["show", "class2-stale-test:src/main/java/com/example/Calculator.java"],
			{ cwd: FIXTURE },
		);
		expect(stdout).toContain("return a * b");
	});

	it("class3 branch has spec addition without a test", async () => {
		const { stdout } = await exec(
			"git",
			["show", "class3-missing-test:docs/spec/calculator.md"],
			{ cwd: FIXTURE },
		);
		expect(stdout).toContain("add(10, 20)");
	});
});