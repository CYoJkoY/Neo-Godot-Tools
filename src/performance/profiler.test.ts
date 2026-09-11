import { strict as assert } from "node:assert";
import { test } from "node:test";
import { PerformanceProfiler } from "./profiler.js";

test("PerformanceProfiler records count, total and maximum duration", () => {
	const profiler = new PerformanceProfiler();
	profiler.record("parse", 2);
	profiler.record("parse", 3);

	assert.deepEqual(profiler.getSnapshot(), {
		parse: { count: 2, totalMs: 5, maxMs: 3 },
	});
});

test("FileIndex profiling is observable through the shared profiler", async () => {
	const { FileIndex } = await import("../index/file_index.js");
	const { languageProfiler } = await import("./profiler.js");
	languageProfiler.reset();

	new FileIndex().update("file:///profile.gd", "class_name Profile\nfunc run() -> void:\n\tpass\n");
	const snapshot = languageProfiler.getSnapshot();

	assert.ok(snapshot.parse.count >= 1);
	assert.ok(snapshot.parse.totalMs >= 0);
	assert.ok(snapshot.collectSymbols.count >= 1);
});
