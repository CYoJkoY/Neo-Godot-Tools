import { strict as assert } from "node:assert";
import { test } from "node:test";
import {
	type LanguageMetric,
	type PerformanceProfiler,
	type PerformanceSnapshot,
	createPerformanceProfiler,
} from "./profiler.js";

function sampleFor(snapshot: PerformanceSnapshot, metric: LanguageMetric) {
	const sample = snapshot[metric];
	assert.ok(sample, `expected a '${metric}' sample`);
	return sample;
}

test("PerformanceProfiler records aggregate and percentile latency", () => {
	const profiler: PerformanceProfiler = createPerformanceProfiler();
	profiler.record("parse", 2);
	profiler.record("parse", 3);

	const sample = sampleFor(profiler.getSnapshot(), "parse");
	assert.equal(sample.count, 2);
	assert.equal(sample.totalMs, 5);
	assert.equal(sample.maxMs, 3);
	assert.equal(sample.p50Ms, 2);
	assert.equal(sample.p95Ms, 3);
	assert.equal(sample.p99Ms, 3);
});

test("PerformanceProfiler bounds retained latency samples", () => {
	const profiler: PerformanceProfiler = createPerformanceProfiler();
	for (let index = 0; index < 513; index++) profiler.record("parse", index);

	// The profiler keeps the 512 most recent samples (1..512) and uses the
	// nearest-rank definition, so p95 maps to index 486 of the retained window.
	const sample = sampleFor(profiler.getSnapshot(), "parse");
	assert.equal(sample.count, 513);
	assert.equal(sample.maxMs, 512);
	assert.equal(sample.p50Ms, 256);
	assert.equal(sample.p95Ms, 487);
	assert.equal(sample.p99Ms, 507);
});

test("FileIndex profiling is observable through the shared profiler", async () => {
	const { FileIndex } = await import("../index/file_index.js");
	const { languageProfiler } = await import("./profiler.js");
	languageProfiler.reset();

	new FileIndex().update("file:///profile.gd", "class_name Profile\nfunc run() -> void:\n\tpass\n");
	const snapshot = languageProfiler.getSnapshot();

	assert.ok(sampleFor(snapshot, "parse").count >= 1);
	assert.ok(sampleFor(snapshot, "parse").totalMs >= 0);
	assert.ok(sampleFor(snapshot, "collectSymbols").count >= 1);
});
