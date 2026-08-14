import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { WebhookRouteStore } from "../../src/notify/route-store.js";

describe("WebhookRouteStore", () => {
	let dir: string;
	let store: WebhookRouteStore;

	beforeEach(() => {
		dir = mkdtempSync(join(tmpdir(), "route-store-"));
		store = new WebhookRouteStore(join(dir, "routes.db"));
	});

	afterEach(() => {
		store.close();
		rmSync(dir, { recursive: true, force: true });
	});

	it("starts empty", () => {
		expect(store.list()).toEqual([]);
		expect(store.getMapping()).toEqual({});
	});

	it("adds routes and upserts on the same pattern", () => {
		store.add("ultron/*", "cid-1", "alice");
		store.add("guild/*", "cid-2", "bob");
		expect(store.getMapping()).toEqual({
			"ultron/*": "cid-1",
			"guild/*": "cid-2",
		});

		store.add("ultron/*", "cid-new", "carol");
		expect(store.getMapping()["ultron/*"]).toBe("cid-new");
	});

	it("persists across reopen (real SQLite file, not memory)", () => {
		store.add("ultron/*", "cid-1", "alice");
		store.close();

		const reopened = new WebhookRouteStore(join(dir, "routes.db"));
		expect(reopened.getMapping()).toEqual({ "ultron/*": "cid-1" });
		const route = reopened.list().find((r) => r.pattern === "ultron/*");
		expect(route?.createdBy).toBe("alice");
		expect(route?.createdAt).toBeTruthy();
		reopened.close();
		// keep afterEach close() idempotent for this test
		store = new WebhookRouteStore(join(dir, "routes.db"));
	});

	it("removes a route and reports whether it existed", () => {
		store.add("a/b", "cid-1");
		expect(store.remove("a/b")).toBe(true);
		expect(store.remove("a/b")).toBe(false);
		expect(store.getMapping()).toEqual({});
	});

	it("rejects blank pattern and blank conversation id at the boundary", () => {
		expect(() => store.add("", "cid")).toThrow(/pattern/);
		expect(() => store.add("  ", "cid")).toThrow(/pattern/);
		expect(() => store.add("a/b", "")).toThrow(/conversation/);
	});

	it("lists routes in insertion order", () => {
		store.add("p1", "c1");
		store.add("p2", "c2");
		store.add("p3", "c3");
		expect(store.list().map((r) => r.pattern)).toEqual(["p1", "p2", "p3"]);
	});
});
