#!/usr/bin/env ts-node
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { performance } from "node:perf_hooks";
import { pathToFileURL } from "node:url";
import {
	createBindingIndex,
	createFileIndex,
	createSymbolIndex,
	createTypeResolutionIndex,
} from "../src/index/index.js";
import { getGDScriptBuiltin } from "../src/language/semantic/gdscript_builtins.js";
import { SemanticQueryEngine } from "../src/language/semantic/query_engine.js";

type Sample = { p50: number; p95: number; p99: number; max: number };
type QueryKind = "type" | "definition" | "hover" | "completion";
type QuerySite = { uri: string; offset: number };
type QuerySamples = Record<QueryKind, number[]>;

const MAX_QUERY_SITES = 60;
const QUERY_WARMUP_ROUNDS = 3;
const QUERY_SAMPLE_ROUNDS = 5;
const SINGLE_EDIT_SAMPLES = 20;
const RAPID_TYPING_SAMPLES = 50;
const QUERY_KINDS: readonly QueryKind[] = ["type", "definition", "hover", "completion"];

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
	console.error(
		"Usage: ts-node tools/semantic_project_benchmark.ts <godot-project-path> [--max-files N] [--output <json-path>]",
	);
	process.exit(1);
}

function fail(message: string): never {
	console.error(message);
	process.exit(1);
}

function parseArguments(args: string[]): { projectRoot: string; maxFiles?: number; outputPath?: string } {
	const parsed = args.reduce(
		(state, argument, index) => {
			if (state.consumedIndexes.has(index)) return state;
			if (argument === "--max-files") {
				const value = args[index + 1];
				const maxFiles = value === undefined ? Number.NaN : Number(value);
				if (!Number.isSafeInteger(maxFiles) || maxFiles < 1) usage();
				state.maxFiles = maxFiles;
				state.consumedIndexes.add(index + 1);
				return state;
			}
			if (argument === "--output") {
				const value = args[index + 1];
				if (!value || value.startsWith("--")) usage();
				state.outputPath = path.resolve(value);
				state.consumedIndexes.add(index + 1);
				return state;
			}
			if (argument.startsWith("--") || state.projectArg !== undefined) usage();
			state.projectArg = argument;
			return state;
		},
		{
			projectArg: undefined as string | undefined,
			maxFiles: undefined as number | undefined,
			outputPath: undefined as string | undefined,
			consumedIndexes: new Set<number>(),
		},
	);

	if (!parsed.projectArg) usage();
	const projectRoot = path.resolve(parsed.projectArg);
	const projectStats = (() => {
		try {
			return fs.statSync(projectRoot);
		} catch {
			return undefined;
		}
	})();
	if (!projectStats) fail(`Godot project path does not exist: ${projectRoot}`);
	if (!projectStats.isDirectory()) fail(`Godot project path is not a directory: ${projectRoot}`);
	return { projectRoot, maxFiles: parsed.maxFiles, outputPath: parsed.outputPath };
}

function readProjectMetadata(root: string): { name: string; godotVersion?: string } {
	let configuration = "";
	try {
		configuration = fs.readFileSync(path.join(root, "project.godot"), "utf8");
	} catch {
		return { name: path.basename(root) };
	}
	const name = configuration.match(/^\s*config\/name\s*=\s*"((?:\\.|[^"\\])*)"/m)?.[1];
	const features = configuration.match(/^\s*config\/features\s*=\s*([^\r\n]+)/m)?.[1];
	const godotVersion = features?.match(/["'](\d+\.\d+(?:\.\d+)?)/)?.[1];
	return { name: name?.replace(/\\(["\\])/g, "$1") || path.basename(root), godotVersion };
}

function memorySnapshot(): { rssBytes: number; heapUsedBytes: number; externalBytes: number } {
	const memory = process.memoryUsage();
	return {
		rssBytes: memory.rss,
		heapUsedBytes: memory.heapUsed,
		externalBytes: memory.external,
	};
}

function createQuerySamples(): QuerySamples {
	return { type: [], definition: [], hover: [], completion: [] };
}

function runQuery(semantic: SemanticQueryEngine, kind: QueryKind, site: QuerySite): void {
	switch (kind) {
		case "type":
			semantic.getType(site.uri, { offset: site.offset });
			return;
		case "definition":
			semantic.getDefinition(site.uri, { offset: site.offset });
			return;
		case "hover":
			semantic.getHover(site.uri, { offset: site.offset });
			return;
		case "completion":
			semantic.getCompletions(site.uri, { offset: site.offset });
			return;
	}
}

function selectQuerySites(
	scripts: readonly string[],
	files: ReturnType<typeof createFileIndex>,
): { sites: QuerySite[]; available: number } {
	const candidates = scripts.flatMap((filename) => {
		const uri = pathToFileURL(filename).toString();
		const file = files.get(uri);
		if (!file) return [];
		return file.symbols.flatMap((symbol) => {
			const offset =
				typeof symbol.nameOffset === "number"
					? symbol.nameOffset
					: file.source.indexOf(symbol.name, symbol.range.start.offset);
			if (
				offset < symbol.range.start.offset ||
				offset + symbol.name.length > Math.min(symbol.range.end.offset, file.source.length) ||
				file.source.slice(offset, offset + symbol.name.length) !== symbol.name
			) {
				return [];
			}
			return [{ uri, offset }];
		});
	});
	const unique = [...new Map(candidates.map((site) => [`${site.uri}:${site.offset}`, site])).values()].sort(
		(left, right) => left.uri.localeCompare(right.uri) || left.offset - right.offset,
	);
	if (unique.length <= MAX_QUERY_SITES) return { sites: unique, available: unique.length };
	const sites = Array.from({ length: MAX_QUERY_SITES }, (_, index) => {
		const candidateIndex = Math.floor((index * (unique.length - 1)) / (MAX_QUERY_SITES - 1));
		return unique[candidateIndex];
	});
	return { sites, available: unique.length };
}

const { projectRoot, maxFiles, outputPath } = parseArguments(process.argv.slice(2));
const discoveredScripts = collectScripts(projectRoot);
const scripts = maxFiles === undefined ? discoveredScripts : discoveredScripts.slice(0, maxFiles);
if (!scripts.length) fail(`No GDScript files found in ${projectRoot}`);

const files = createFileIndex();
const symbols = createSymbolIndex(files);
const bindings = createBindingIndex(files);
const types = createTypeResolutionIndex(files, symbols, bindings, (name) => getGDScriptBuiltin(name)?.returnType);
const semantic = new SemanticQueryEngine(files, symbols, bindings, types);

let sourceBytes = 0;
const coldStart = performance.now();
for (const filename of scripts) {
	const uri = pathToFileURL(filename).toString();
	const source = fs.readFileSync(filename, "utf8");
	sourceBytes += Buffer.byteLength(source, "utf8");
	files.update(uri, source, 1);
	symbols.update(uri);
	bindings.update(uri);
}
const coldIndexMs = performance.now() - coldStart;
const memoryAfterIndex = memorySnapshot();

const targetFilename = scripts[Math.floor(scripts.length / 2)];
const targetUri = pathToFileURL(targetFilename).toString();
const target = files.get(targetUri);
if (!target) throw new Error(`Unable to index benchmark target: ${targetFilename}`);
const targetFunction = target.symbols.find(
	(symbol) => symbol.kind === "function" && typeof symbol.nameOffset === "number",
);
const candidate = target.source.indexOf("func ");
const targetOffset =
	targetFunction?.nameOffset ?? (candidate >= 0 ? candidate + 5 : Math.min(target.source.length, 1));

const editSamples = Array.from({ length: SINGLE_EDIT_SAMPLES }, (_, iteration) => {
	const edited = `${target.source}\n# benchmark edit ${iteration}\n`;
	const start = performance.now();
	files.update(targetUri, edited, iteration + 2);
	symbols.update(targetUri);
	bindings.update(targetUri);
	types.invalidate([targetUri]);
	semantic.invalidate([targetUri]);
	return performance.now() - start;
});

const selectedQuerySites = selectQuerySites(scripts, files);
const querySites =
	selectedQuerySites.sites.length > 0
		? selectedQuerySites.sites
		: [{ uri: targetUri, offset: targetOffset }];
const uncachedQuerySamples = createQuerySamples();
for (const site of querySites) {
	for (const kind of QUERY_KINDS) {
		semantic.clear();
		types.clear();
		const start = performance.now();
		runQuery(semantic, kind, site);
		uncachedQuerySamples[kind].push(performance.now() - start);
	}
}

const warmQuerySamples = createQuerySamples();
for (const kind of QUERY_KINDS) {
	semantic.clear();
	types.clear();
	Array.from({ length: QUERY_WARMUP_ROUNDS }).reduce<number>((roundCount) => {
		querySites.reduce((siteCount, site) => {
			runQuery(semantic, kind, site);
			return siteCount + 1;
		}, 0);
		return roundCount + 1;
	}, 0);
	Array.from({ length: QUERY_SAMPLE_ROUNDS }).reduce<number>((roundCount) => {
		querySites.reduce((siteCount, site) => {
			const start = performance.now();
			runQuery(semantic, kind, site);
			warmQuerySamples[kind].push(performance.now() - start);
			return siteCount + 1;
		}, 0);
		return roundCount + 1;
	}, 0);
}

const rapidTyping = Array.from({ length: RAPID_TYPING_SAMPLES }, (_, iteration) => {
	const edited = `${target.source}\n# benchmark typing ${iteration}\n`;
	const start = performance.now();
	files.update(targetUri, edited, 100 + iteration);
	symbols.update(targetUri);
	bindings.update(targetUri);
	types.invalidate([targetUri]);
	semantic.invalidate([targetUri]);
	semantic.getCompletions(targetUri, { offset: targetOffset });
	return performance.now() - start;
});

const projectMetadata = readProjectMetadata(projectRoot);
const cpu = os.cpus()[0];
const result = {
	schemaVersion: 1,
	benchmark: "semantic-project",
	capturedAt: new Date().toISOString(),
	environment: {
		node: process.version,
		platform: process.platform,
		osRelease: os.release(),
		architecture: process.arch,
		logicalCpuCount: os.cpus().length,
		cpuModel: cpu?.model ?? "unknown",
		totalMemoryBytes: os.totalmem(),
	},
	project: {
		name: projectMetadata.name,
		godotVersion: projectMetadata.godotVersion,
		scriptFilesDiscovered: discoveredScripts.length,
		scriptFilesIndexed: scripts.length,
		sourceBytesIndexed: sourceBytes,
		querySitesAvailable: selectedQuerySites.available,
		querySitesSampled: querySites.length,
		maxFiles: maxFiles ?? null,
	},
	sampleCounts: {
		coldIndex: 1,
		singleEdit: editSamples.length,
		uncachedSemanticPerKind: uncachedQuerySamples.type.length,
		queryWarmupRounds: QUERY_WARMUP_ROUNDS,
		warmSemanticPerKind: warmQuerySamples.type.length,
		rapidTyping: rapidTyping.length,
	},
	coldIndexMs: Number(coldIndexMs.toFixed(2)),
	memoryBytes: {
		afterIndex: memoryAfterIndex,
		afterBenchmarks: memorySnapshot(),
	},
	singleEditMs: report(editSamples),
	rapidTypingMs: report(rapidTyping),
	uncachedSemanticMs: Object.fromEntries(
		QUERY_KINDS.map((kind) => [kind, report(uncachedQuerySamples[kind])]),
	) as Record<QueryKind, Sample>,
	warmSemanticMs: Object.fromEntries(
		QUERY_KINDS.map((kind) => [kind, report(warmQuerySamples[kind])]),
	) as Record<QueryKind, Sample>,
};
const json = JSON.stringify(result, null, 2);
if (outputPath) fs.writeFileSync(outputPath, `${json}\n`, "utf8");
process.stdout.write(`${json}\n`);
