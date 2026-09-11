import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative, resolve } from "node:path";
import { performance } from "node:perf_hooks";
import { BindingIndex, FileIndex, SymbolIndex, TypeResolutionIndex } from "../src/index/index.js";

interface Sample {
	name: string;
	values: number[];
}

function percentile(values: number[], percentileValue: number): number {
	if (!values.length) return 0;
	const sorted = [...values].sort((a, b) => a - b);
	const index = Math.min(sorted.length - 1, Math.max(0, Math.ceil((percentileValue / 100) * sorted.length) - 1));
	return sorted[index];
}

function collectGDScriptFiles(root: string): string[] {
	const result: string[] = [];
	const visit = (directory: string): void => {
		for (const entry of readdirSync(directory)) {
			if (entry === ".godot" || entry === ".git") continue;
			const path = join(directory, entry);
			const stats = statSync(path);
			if (stats.isDirectory()) visit(path);
			else if (stats.isFile() && path.endsWith(".gd")) result.push(path);
		}
	};
	visit(root);
	return result.sort();
}

function measure(sample: Sample, action: () => void): void {
	const start = performance.now();
	action();
	sample.values.push(performance.now() - start);
}

function report(samples: Sample[]): void {
	for (const sample of samples) {
		console.log(`${sample.name}: p50=${percentile(sample.values, 50).toFixed(2)}ms p95=${percentile(sample.values, 95).toFixed(2)}ms p99=${percentile(sample.values, 99).toFixed(2)}ms n=${sample.values.length}`);
	}
}

const root = resolve(process.argv[2] ?? process.cwd());
const files = collectGDScriptFiles(root);
if (!files.length) {
	console.error(`No .gd files found under ${root}`);
	process.exitCode = 1;
} else {
	const fileIndex = new FileIndex();
	const symbolIndex = new SymbolIndex(fileIndex);
	const bindingIndex = new BindingIndex(fileIndex);
	const typeIndex = new TypeResolutionIndex(fileIndex, symbolIndex, bindingIndex);
	const samples: Sample[] = [
		{ name: "cold-indexing", values: [] },
		{ name: "single-edit", values: [] },
		{ name: "completion-core", values: [] },
	];

	const start = performance.now();
	for (const path of files) {
		const uri = `file://${path.replace(/\\/g, "/")}`;
		fileIndex.update(uri, readFileSync(path, "utf8"), 1);
		symbolIndex.update(uri);
		bindingIndex.update(uri);
	}
	samples[0].values.push(performance.now() - start);

	const targetPath = files[0];
	const targetUri = `file://${targetPath.replace(/\\/g, "/")}`;
	const targetSource = readFileSync(targetPath, "utf8");
	for (let iteration = 0; iteration < 5; iteration++) {
		const edited = `${targetSource}\n# benchmark edit ${iteration}`;
		measure(samples[1], () => {
			fileIndex.update(targetUri, edited, iteration + 2);
			symbolIndex.update(targetUri);
			bindingIndex.update(targetUri);
		typeIndex.invalidate([targetUri]);
		});
	}

	const targetFile = fileIndex.get(targetUri);
	if (targetFile) {
		const offset = Math.max(0, targetFile.source.length - 1);
		for (let iteration = 0; iteration < 20; iteration++) {
			measure(samples[2], () => {
				typeIndex.resolveReceiver(targetUri, offset, "self");
			});
		}
	}

	console.log(`Neo-Godot-Tools semantic benchmark`);
	console.log(`Project: ${root}`);
	console.log(`GDScript files: ${files.length}`);
	report(samples);
	console.log(`relative first file: ${relative(root, targetPath)}`);
}
