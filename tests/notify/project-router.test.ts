import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
	ProjectRouter,
	loadGroupRouting,
} from "../../src/notify/project-router.js";

describe("ProjectRouter.resolve", () => {
	it("prefers exact match over wildcard", () => {
		const router = new ProjectRouter(
			{
				"ultron/*": "cid-wildcard",
				"ultron/ultron-activity-independence": "cid-exact",
				"*": "cid-fallback",
			},
			"cid-default",
		);

		expect(router.resolve("ultron/ultron-activity-independence")).toBe(
			"cid-exact",
		);
		expect(router.resolve("ultron/ultron-guild")).toBe("cid-wildcard");
		expect(router.resolve("other/project")).toBe("cid-fallback");
	});

	it("supports ? single-char wildcards", () => {
		const router = new ProjectRouter({ "team/proj?": "cid-q" }, "");

		expect(router.resolve("team/proj1")).toBe("cid-q");
		expect(router.resolve("team/proj12")).toBeNull();
	});

	it("falls back to the default conversation id", () => {
		const router = new ProjectRouter({}, "cid-default");

		expect(router.resolve("anything/at-all")).toBe("cid-default");
	});

	it("returns null when nothing matches and no default is set", () => {
		const router = new ProjectRouter({ "ultron/*": "cid-u" }, "");

		expect(router.resolve("other/project")).toBeNull();
	});

	it("treats an empty default as no default", () => {
		const router = new ProjectRouter({ "*": "cid-all" }, "");

		expect(router.resolve("x/y")).toBe("cid-all");
	});
});

describe("loadGroupRouting", () => {
	let dir: string;
	beforeEach(() => {
		dir = mkdtempSync(join(tmpdir(), "group-routing-"));
	});
	afterEach(() => {
		rmSync(dir, { recursive: true, force: true });
	});

	it("returns empty routing when the file is missing", () => {
		expect(loadGroupRouting(join(dir, "absent.json"))).toEqual({
			routes: {},
			defaultConversationId: "",
		});
	});

	it("parses routes and default conversation id", () => {
		const file = join(dir, "group-routing.json");
		writeFileSync(
			file,
			JSON.stringify({
				routes: { "ultron/*": "cid-u" },
				defaultConversationId: "cid-default",
			}),
		);

		expect(loadGroupRouting(file)).toEqual({
			routes: { "ultron/*": "cid-u" },
			defaultConversationId: "cid-default",
		});
	});

	it("throws on malformed JSON (fail loud)", () => {
		const file = join(dir, "bad.json");
		writeFileSync(file, "{ not json");

		expect(() => loadGroupRouting(file)).toThrow();
	});

	it("throws on non-string route values", () => {
		const file = join(dir, "bad-values.json");
		writeFileSync(file, JSON.stringify({ routes: { "a/b": 42 } }));

		expect(() => loadGroupRouting(file)).toThrow(/routes/);
	});
});

describe("ProjectRouter dynamic layer", () => {
	it("dynamic exact beats static exact and static wildcard", () => {
		const router = new ProjectRouter(
			{ "ultron/x": "cid-static-exact", "ultron/*": "cid-static-wild" },
			"cid-default",
			() => ({ "ultron/x": "cid-dynamic-exact" }),
		);

		expect(router.resolve("ultron/x")).toBe("cid-dynamic-exact");
		expect(router.resolve("ultron/y")).toBe("cid-static-wild");
		expect(router.resolve("other")).toBe("cid-default");
	});

	it("dynamic wildcard beats static layers but not dynamic exact", () => {
		const router = new ProjectRouter(
			{ "a/b": "cid-static" },
			"",
			() => ({ "a/*": "cid-dynamic-wild", "a/b": "cid-dynamic-exact" }),
		);

		expect(router.resolve("a/c")).toBe("cid-dynamic-wild");
		expect(router.resolve("a/b")).toBe("cid-dynamic-exact");
	});

	it("reads the source on every resolve (live updates, no rebuild)", () => {
		let mapping: Readonly<Record<string, string>> = {};
		const router = new ProjectRouter({}, "", () => mapping);

		expect(router.resolve("p/q")).toBeNull();
		mapping = { "p/*": "cid-live" };
		expect(router.resolve("p/q")).toBe("cid-live");
	});

	it("falls through to static and default when dynamic is empty", () => {
		const router = new ProjectRouter(
			{ "s/*": "cid-static" },
			"cid-default",
			() => ({}),
		);

		expect(router.resolve("s/x")).toBe("cid-static");
		expect(router.resolve("z")).toBe("cid-default");
	});

	it("works without a dynamic source (static-only callers unchanged)", () => {
		const router = new ProjectRouter({ "s/*": "cid-static" }, "");

		expect(router.resolve("s/x")).toBe("cid-static");
		expect(router.resolve("z")).toBeNull();
	});
});
