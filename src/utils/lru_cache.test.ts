import { strict as assert } from "node:assert";
import { describe, it } from "node:test";
import { LruCache } from "./lru_cache.js";

describe("LruCache", () => {
	it("evicts the least recently used entry beyond its capacity", () => {
		const cache = new LruCache<string, number>({ capacity: 2 });
		cache.set("a", 1);
		cache.set("b", 2);
		cache.get("a");
		cache.set("c", 3);
		assert.equal(cache.get("a"), 1, "a was read most recently");
		assert.equal(cache.get("b"), undefined, "b is the least recently used");
		assert.equal(cache.get("c"), 3);
		assert.equal(cache.size, 2);
	});

	it("expires entries past their ttl", async () => {
		const cache = new LruCache<string, number>({ ttlMs: 5 });
		cache.set("a", 1);
		assert.equal(cache.get("a"), 1);
		await new Promise((resolve) => setTimeout(resolve, 20));
		assert.equal(cache.get("a"), undefined);
		assert.equal(cache.has("a"), false);
		assert.equal(cache.size, 0, "a stale entry is dropped instead of kept");
	});

	it("stores falsy values without confusing them with a miss", () => {
		const cache = new LruCache<string, number | null>();
		cache.set("missing", null);
		assert.equal(cache.has("missing"), true);
		assert.equal(cache.get("missing"), null);
		assert.equal(cache.get("absent"), undefined);
	});

	it("deletes and clears entries", () => {
		const cache = new LruCache<string, number>();
		cache.set("a", 1);
		cache.set("b", 2);
		cache.delete("a");
		assert.deepEqual([...cache.keys()], ["b"]);
		cache.clear();
		assert.equal(cache.size, 0);
	});
});
