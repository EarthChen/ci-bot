import { describe, expect, it, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, readFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createCiRepairDefinition } from "../../src/agent/ci-repair-definition.js";
import type { AgentRunInput } from "../../src/agent/runner.js";

const CHECKSTYLE_CI_LOG = `
❌ 以下违规位于本次修改的行上（阻断）:
  [ERROR] /builds/g/p/ultron-room-service/src/main/java/com/foo/Foo.java:46:52: Variable 'propCache' must be private. [VisibilityModifier]
  [ERROR] /builds/g/p/ultron-room-api/src/main/java/com/bar/Bar.java:200:10: unused import. [UnusedImports]
`;

function makeInput(mrDiff: string): AgentRunInput {
	return {
		projectId: "31041",
		pipelineId: 100033426,
		ref: "refs/merge-requests/281/head",
		sha: "95fd03b89086827e5b343f18728484ec25af6762",
		ciLog: "test failure log",
		mrDiff,
		cwd: "",
		sourceBranch: "ci-self-heal/refs/merge-requests/281/head-95fd03b8",
		targetBranch: "dev-backend-activity",
	};
}

describe("buildCiPrompt — MR diff 索引（MR !281 提速）", () => {
	let cwd: string;
	beforeEach(() => {
		cwd = mkdtempSync(join(tmpdir(), "ci-prompt-"));
	});
	afterEach(() => {
		rmSync(cwd, { recursive: true, force: true });
	});

	it("有 mrDiff → 落盘 mr-diff-index.txt，prompt 指引用索引定位", () => {
		const mrDiff = [
			"--- src/main/java/A.java",
			"+++ src/main/java/A.java",
			"@@ -1 +1 @@",
			"+changed",
		].join("\n");
		const prompt = createCiRepairDefinition(cwd).buildPrompt(makeInput(mrDiff));

		const indexPath = join(cwd, "mr-diff-index.txt");
		expect(existsSync(indexPath)).toBe(true);
		expect(readFileSync(indexPath, "utf8")).toContain("src/main/java/A.java  +1 -0");
		expect(prompt).toContain(indexPath);
		expect(prompt).toContain("mr-diff.patch");
	});

	it("无 mrDiff → 不写索引文件，prompt 不出现索引行", () => {
		const prompt = createCiRepairDefinition(cwd).buildPrompt(makeInput(""));

		expect(existsSync(join(cwd, "mr-diff-index.txt"))).toBe(false);
		expect(prompt).not.toContain("mr-diff-index.txt");
	});
});

describe("buildCiPrompt — session 复用声明（ADR-0007）", () => {
	const base = {
		projectId: "31041",
		pipelineId: 100033538,
		ref: "refs/merge-requests/281/head",
		sha: "bec0fab3ee9c6414eb522dc8e88b96ea2698f5b1",
		ciLog: "new failure log",
		mrDiff: "",
		cwd: "",
		sourceBranch: "ci-self-heal/x",
		targetBranch: "dev",
	};

	it("有 reuseMeta → 声明新旧 commit，警示不得沿用旧诊断", () => {
		const prompt = createCiRepairDefinition("/tmp/x").buildPrompt({
			...base,
			reuseMeta: { pipelineId: 100033426, sha: "95fd03b89086827e5b343f18728484ec25af6762" },
		});
		expect(prompt).toContain("MR 已更新到新 commit");
		expect(prompt).toContain("100033426"); // 旧 pipeline
		expect(prompt).toContain("95fd03b8"); // 旧 sha 前缀
		expect(prompt).toContain("bec0fab3"); // 新 sha 前缀
		expect(prompt).toContain("不得直接沿用旧诊断");
	});

	it("无 reuseMeta → 无复用声明", () => {
		const prompt = createCiRepairDefinition("/tmp/x").buildPrompt(base);
		expect(prompt).not.toContain("Session 复用");
	});
});

describe("buildCiPrompt — failedStages 与 violations 预解析", () => {
	let cwd: string;
	beforeEach(() => {
		cwd = mkdtempSync(join(tmpdir(), "ci-prompt-stages-"));
	});
	afterEach(() => {
		rmSync(cwd, { recursive: true, force: true });
	});

	const baseInput = (): AgentRunInput => ({
		projectId: "31041",
		pipelineId: 100033426,
		ref: "refs/merge-requests/281/head",
		sha: "95fd03b89086827e5b343f18728484ec25af6762",
		ciLog: CHECKSTYLE_CI_LOG,
		mrDiff: "",
		cwd: "",
		sourceBranch: "ci-self-heal/x",
		targetBranch: "dev",
	});

	it("有 failedStages → prompt 包含准确 stage 描述", () => {
		const prompt = createCiRepairDefinition(cwd).buildPrompt({
			...baseInput(),
			failedStages: ["checkstyle-check", "spotbugs-check"],
		});
		expect(prompt).toContain("质量阶段 checkstyle-check, spotbugs-check 失败");
		expect(prompt).not.toContain("pipeline 单测失败");
	});

	it("无 failedStages → 保持「单测失败」描述", () => {
		const prompt = createCiRepairDefinition(cwd).buildPrompt(baseInput());
		expect(prompt).toContain("pipeline 单测失败");
		expect(prompt).not.toContain("质量阶段");
	});

	it("checkstyle 场景 → 写入 violations.json 并在 prompt 引用", () => {
		const mrDiff = [
			"--- ultron-room-service/src/main/java/com/foo/Foo.java",
			"+++ ultron-room-service/src/main/java/com/foo/Foo.java",
			"@@ -40,10 +40,12 @@",
			"+changed",
		].join("\n");
		const prompt = createCiRepairDefinition(cwd).buildPrompt({
			...baseInput(),
			mrDiff,
			failedStages: ["checkstyle-check"],
		});

		const violationsPath = join(cwd, "violations.json");
		expect(existsSync(violationsPath)).toBe(true);
		expect(prompt).toContain(violationsPath);

		const violations = JSON.parse(readFileSync(violationsPath, "utf8"));
		expect(violations.length).toBeGreaterThan(0);
		expect(violations[0]).toMatchObject({
			file: expect.any(String),
			line: expect.any(Number),
			inScope: expect.any(Boolean),
		});
	});

	it("violations 标注 inScope：hunk 内可修，hunk 外不可修", () => {
		const mrDiff = [
			"--- ultron-room-service/src/main/java/com/foo/Foo.java",
			"+++ ultron-room-service/src/main/java/com/foo/Foo.java",
			"@@ -40,10 +40,12 @@",
			"+changed",
		].join("\n");
		createCiRepairDefinition(cwd).buildPrompt({
			...baseInput(),
			mrDiff,
			failedStages: ["checkstyle-check"],
		});

		const violations = JSON.parse(
			readFileSync(join(cwd, "violations.json"), "utf8"),
		);
		const inScope = violations.find(
			(v: { line: number; inScope: boolean }) => v.line === 46,
		);
		const outScope = violations.find(
			(v: { line: number; inScope: boolean }) => v.line === 200,
		);
		expect(inScope?.inScope).toBe(true);
		expect(outScope?.inScope).toBe(false);
	});

	it("checkstyle 场景 → prompt 含 CLI 快路径提示", () => {
		const prompt = createCiRepairDefinition(cwd).buildPrompt({
			...baseInput(),
			failedStages: ["checkstyle-check"],
		});
		expect(prompt).toContain("checkstyle 验证可用 CLI 快路径");
		expect(prompt).toContain("checkstyle-*.jar");
	});

	it("violations 可修数量 → prompt 告知 N/M 在 hunk 内", () => {
		const mrDiff = [
			"--- ultron-room-service/src/main/java/com/foo/Foo.java",
			"+++ ultron-room-service/src/main/java/com/foo/Foo.java",
			"@@ -40,10 +40,12 @@",
			"+changed",
		].join("\n");
		const prompt = createCiRepairDefinition(cwd).buildPrompt({
			...baseInput(),
			mrDiff,
			failedStages: ["checkstyle-check"],
		});
		expect(prompt).toMatch(/1\/2 个违规在 hunk 内可修/);
		expect(prompt).toContain("其余超范围无需处理");
	});
});

describe("buildCiPrompt — 修复重放声明（ADR-0012）", () => {
	const base = {
		projectId: "31041",
		pipelineId: 100034349,
		ref: "refs/merge-requests/432/head",
		sha: "6034c68cb2e6fdcae6d431a58e7398317cea4768",
		ciLog: "checkstyle failure",
		mrDiff: "",
		cwd: "",
		sourceBranch: "ci-self-heal/x",
		targetBranch: "dev",
	};

	it("replay=applied → 声明改动已重放，先验证再只修增量", () => {
		const prompt = createCiRepairDefinition("/tmp/x").buildPrompt({
			...base,
			replay: { outcome: "applied", fromPipeline: 100034275 },
		});
		expect(prompt).toContain("修复重放");
		expect(prompt).toContain("已重放");
		expect(prompt).toContain("100034275");
		expect(prompt).toContain("只处理");
	});

	it("replay=empty → 声明修复已在新代码中，勿重做", () => {
		const prompt = createCiRepairDefinition("/tmp/x").buildPrompt({
			...base,
			replay: { outcome: "empty", fromPipeline: 100034275 },
		});
		expect(prompt).toContain("已包含在当前代码中");
		expect(prompt).toContain("勿重做");
	});

	it("无 replay → 无重放声明", () => {
		const prompt = createCiRepairDefinition("/tmp/x").buildPrompt(base);
		expect(prompt).not.toContain("修复重放");
	});
});
