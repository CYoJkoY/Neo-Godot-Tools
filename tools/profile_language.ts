#!/usr/bin/env ts-node
import { performance } from "node:perf_hooks";
import { parseGDScript } from "../src/analyzer/parser";
import { collectSymbols } from "../src/index/symbol";

function buildSource(index: number): string {
	return `class_name Profile${index}\nextends Node\n\nsignal changed(value: int)\nconst MAX_VALUE: int = 100\nvar health: int = MAX_VALUE\nvar label: String = "profile-${index}"\n\nfunc update_value(value: int, amount: int = 1) -> int:\n\tvar next_value: int = value + amount\n\tif next_value > MAX_VALUE:\n\t\tnext_value = MAX_VALUE\n\treturn next_value\n\nfunc reset() -> void:\n\thealth = MAX_VALUE\n\tchanged.emit(health)\n`;
}

function percentile(values: number[], fraction: number): number {
	const sorted = [...values].sort((a, b) => a - b);
	return sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * fraction))] ?? 0;
}

const fileCount = Number(process.env.PROFILE_FILES ?? 200);
const iterations = Number(process.env.PROFILE_ITERATIONS ?? 5);
const sources = Array.from({ length: fileCount }, (_, index) => buildSource(index));

for (let index = 0; index < Math.min(20, fileCount); index++) parseGDScript(sources[index]);

const parseTimes: number[] = [];
const symbolTimes: number[] = [];
const totalTimes: number[] = [];
const started = performance.now();

for (let iteration = 0; iteration < iterations; iteration++) {
	for (const source of sources) {
		const totalStart = performance.now();
		const parseStart = performance.now();
		const result = parseGDScript(source);
		parseTimes.push(performance.now() - parseStart);
		const symbolStart = performance.now();
		collectSymbols(result.ast, "file:///profile.gd");
		symbolTimes.push(performance.now() - symbolStart);
		totalTimes.push(performance.now() - totalStart);
	}
}

const elapsed = performance.now() - started;
const sampleCount = sources.length * iterations;
console.log(JSON.stringify({
	files: fileCount,
	iterations,
	samples: sampleCount,
	elapsedMs: Number(elapsed.toFixed(3)),
	parseMs: {
		p50: Number(percentile(parseTimes, 0.5).toFixed(3)),
		p95: Number(percentile(parseTimes, 0.95).toFixed(3)),
		max: Number(Math.max(...parseTimes).toFixed(3)),
	},
	collectSymbolsMs: {
		p50: Number(percentile(symbolTimes, 0.5).toFixed(3)),
		p95: Number(percentile(symbolTimes, 0.95).toFixed(3)),
		max: Number(Math.max(...symbolTimes).toFixed(3)),
	},
	fileUpdateCoreMs: {
		p50: Number(percentile(totalTimes, 0.5).toFixed(3)),
		p95: Number(percentile(totalTimes, 0.95).toFixed(3)),
		max: Number(Math.max(...totalTimes).toFixed(3)),
	},
	throughputFilesPerSecond: Number((sampleCount / (elapsed / 1000)).toFixed(2)),
}, null, 2));
