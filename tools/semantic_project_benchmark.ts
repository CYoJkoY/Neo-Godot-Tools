#!/usr/bin/env ts-node
import { performance } from "node:perf_hooks";
import * as fs from "node:fs";
import * as path from "node:path";
import { BindingIndex, FileIndex, SymbolIndex, TypeResolutionIndex } from "../src/index/index.js";
import { SemanticQueryEngine } from "../src/language/semantic/query_engine.js";

type Sample = { p50: number; p95: number; p99: number; max: number };

function percentile(values: readonly number[], fraction: number): number {
	if (!values.length) return 0;
	const sorted = [...values].sort((a, b) => a - b);
	return sorted[Math.min(sorted.length - 1, Math.ceil(fraction * sorted.length) - 1)];
}

function report(values: readonly number[]): Sample {
	return {
		p50: Number(percentile(values, 0.5).toFixed(2)),
		p95: Number(percentile(values, 0.95).toFixed(2)),
		p99: Number(percentile(values, 0.99).toFixed(2)),
		max: Number(Math.max(...values, 0).toFixed(2)),
	};
}

function collectScripts(root: string): string[] {
	const result: string[] = [];
	const stack = [root];
	while (stack.length) {
		const current = stack.pop()!;
		for (const entry of fs.readdirSync(current, { withFileTypes: true })) {
			if (entry.name === ".git" || entry.name === "node_modules" || entry.name === ".godot") continue;
			const full = path.join(current, entry.name);
			if (entry.isDirectory()) stack.push(full);
			else if (entry.isFile() && entry.name.endsWith(".gd")) result.push(full);
		}
	}
	return result.sort();
}

function usage(): never {
	console.error("Usage: ts-node tools/semantic_project_benchmark.ts <godot-project-path> [--max-files N]");
	process.exit(1);
}

const args = process.argv.slice(2);
const projectArg = args.find((arg) => !arg.startsWith("--"));
if (!projectArg) usage();
const maxIndex = args.indexOf("--max-files");
const maxFiles = maxIndex >= 0 ? Number(args[maxIndex + 1]) : Number.POSITIVE_INFINITY;
if (!Number.isFinite(maxFiles) && maxFiles !== Number.POSITIVE_INFINITY) usage();

const projectRoot = path.resolve(projectArg!);
const scripts = collectScripts(projectRoot).slice(0, maxFiles);
if (!scripts.length) throw new Error(`No GDScript files found in ${projectRoot}`);

const files = new FileIndex();
const symbols = new SymbolIndex(files);
const bindings = new BindingIndex(files);
const types = new TypeResolutionIndex(files, symbols, bindings);
const semantic = new SemanticQueryEngine(files, symbols, bindings, types);

const coldStart = performance.now();
for (const filename of scripts) {
	const uri = `file://${filename.replace(/\\/g, "/")}`;
	const source = fs.readFileSync(filename, "utf8");
	files.update(uri, source, 1);
	symbols.update(uri);
	bindings.update(uri);
}
const coldIndexMs = performance.now() - coldStart;

const targetFilename = scripts[Math.floor(scripts.length / 2)];
const targetUri = `file://${targetFilename.replace(/\\/g, "/")}`;
const target = files.get(targetUri);
if (!target) throw new Error(`Unable to index benchmark target: ${targetFilename}`);
const candidate = target.source.indexOf("func ");
const targetOffset = candidate >= 0 ? candidate + 5 : Math.min(target.source.length, 1);

const editSamples: number[] = [];
for (let iteration = 0; iteration < 20; iteration++) {
	const edited = `${target.source}\n# benchmark edit ${iteration}\n`;
	const start = performance.now();
	files.update(targetUri, edited, iteration + 2);
	symbols.update(targetUri);
	bindings.update(targetUri);
	types.invalidate([targetUri]);
	semantic.invalidate([targetUri]);
	editSamples.push(performance.now() - start);
}

const querySamples = { type: [] as number[], definition: [] as number[], hover: [] as number[], completion: [] as number[] };
for (let iteration = 0; iteration < 60; iteration++) {
	let start = performance.now();
	semantic.getType(targetUri, { offset: targetOffset });
	querySamples.type.push(performance.now() - start);
	start = performance.now();
	semantic.getDefinition(targetUri, { offset: targetOffset });
	querySamples.definition.push(performance.now() - start);
	start = performance.now();
	semantic.getHover(targetUri, { offset: targetOffset });
	querySamples.hover.push(performance.now() - start);
	start = performance.now();
	semantic.getCompletions(targetUri, { offset: targetOffset });
	querySamples.completion.push(performance.now() - start);
}

const rapidTyping: number[] = [];
let typedSource = target.source;
for (let iteration = 0; iteration < 50; iteration++) {
	typedSource += iteration % 2 === 0 ? " " : "_";
	const start = performance.now();
	files.update(targetUri, typedSource, 100 + iteration);
	symbols.update(targetUri);
	bindings.update(targetUri);
	types.invalidate([targetUri]);
	semantic.invalidate([targetUri]);
	semantic.getCompletions(targetUri, { offset: typedSource.length });
	rapidTyping.push(performance.now() - start);
}

console.log(JSON.stringify({
	project: projectRoot,
	files: scripts.length,
	coldIndexMs: Number(coldIndexMs.toFixed(2)),
	singleEditMs: report(editSamples),
	rapidTypingMs: report(rapidTyping),
	semanticMs: {
		type: report(querySamples.type),
		definition: report(querySamples.definition),
		hover: report(querySamples.hover),
		completion: report(querySamples.completion),
	},
}, null, 2));
