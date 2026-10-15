#!/usr/bin/env ts-node
import * as fs from "node:fs";
import * as path from "node:path";

type QueryKind = "type" | "definition" | "hover" | "completion";
type Percentiles = { p50: number; p95: number; p99: number; max: number };
type QueryDistributions = Record<QueryKind, Percentiles>;

interface BenchmarkReport {
	schemaVersion: 1;
	benchmark: "semantic-project";
	capturedAt: string;
	environment: {
		node: string;
		platform: string;
		architecture: string;
		cpuModel: string;
	};
	project: {
		name: string;
		godotVersion?: string;
		scriptFilesIndexed: number;
		sourceBytesIndexed: number;
	};
	coldIndexMs: number;
	singleEditMs: Percentiles;
	rapidTypingMs: Percentiles;
	uncachedSemanticMs: QueryDistributions;
	warmSemanticMs: QueryDistributions;
}

interface MetricRow {
	label: string;
	baseline: number;
	current: number;
}

const DISTRIBUTION_KEYS: readonly (keyof Percentiles)[] = ["p50", "p95", "p99", "max"];
const QUERY_KINDS: readonly QueryKind[] = ["type", "definition", "hover", "completion"];

function fail(message: string): never {
	console.error(message);
	process.exit(1);
}

function usage(): never {
	console.error(
		"Usage: ts-node tools/compare_semantic_benchmarks.ts <baseline-report.json> <current-report.json>",
	);
	process.exit(1);
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isNumber(value: unknown): value is number {
	return typeof value === "number" && Number.isFinite(value);
}

function isNonNegativeNumber(value: unknown): value is number {
	return isNumber(value) && value >= 0;
}

function isNonNegativeInteger(value: unknown): value is number {
	return isNonNegativeNumber(value) && Number.isInteger(value);
}

function isGodotVersion(value: unknown): value is string {
	return typeof value === "string" && /^\d+\.\d+(?:\.\d+)?$/.test(value);
}

function isPercentiles(value: unknown): value is Percentiles {
	if (!isRecord(value)) return false;
	const p50 = value["p50"];
	const p95 = value["p95"];
	const p99 = value["p99"];
	const max = value["max"];
	return (
		isNonNegativeNumber(p50) &&
		isNonNegativeNumber(p95) &&
		isNonNegativeNumber(p99) &&
		isNonNegativeNumber(max) &&
		p50 <= p95 &&
		p95 <= p99 &&
		p99 <= max
	);
}

function isQueryDistributions(value: unknown): value is QueryDistributions {
	return isRecord(value) && QUERY_KINDS.every((kind) => isPercentiles(value[kind]));
}

function isBenchmarkReport(value: unknown): value is BenchmarkReport {
	if (!isRecord(value) || value["schemaVersion"] !== 1 || value["benchmark"] !== "semantic-project") {
		return false;
	}
	const environment = value["environment"];
	const project = value["project"];
	return (
		typeof value["capturedAt"] === "string" &&
		Number.isFinite(Date.parse(value["capturedAt"])) &&
		isRecord(environment) &&
		typeof environment["node"] === "string" &&
		typeof environment["platform"] === "string" &&
		typeof environment["architecture"] === "string" &&
		typeof environment["cpuModel"] === "string" &&
		isRecord(project) &&
		typeof project["name"] === "string" &&
		project["name"].trim().length > 0 &&
		(project["godotVersion"] === undefined || isGodotVersion(project["godotVersion"])) &&
		isNonNegativeInteger(project["scriptFilesIndexed"]) &&
		isNonNegativeInteger(project["sourceBytesIndexed"]) &&
		isNonNegativeNumber(value["coldIndexMs"]) &&
		isPercentiles(value["singleEditMs"]) &&
		isPercentiles(value["rapidTypingMs"]) &&
		isQueryDistributions(value["uncachedSemanticMs"]) &&
		isQueryDistributions(value["warmSemanticMs"])
	);
}

function readReport(filename: string): BenchmarkReport {
	const absolutePath = path.resolve(filename);
	const parsed = (() => {
		try {
			return JSON.parse(fs.readFileSync(absolutePath, "utf8")) as unknown;
		} catch (error) {
			const detail = error instanceof Error ? error.message : String(error);
			return fail(`Cannot read benchmark report "${absolutePath}": ${detail}`);
		}
	})();
	if (!isBenchmarkReport(parsed)) {
		return fail(`Benchmark report "${absolutePath}" does not match schema version 1.`);
	}
	return parsed;
}

function distributionRows(
	label: string,
	baseline: Percentiles,
	current: Percentiles,
): MetricRow[] {
	return DISTRIBUTION_KEYS.map((key) => ({
		label: `${label} ${key}`,
		baseline: baseline[key],
		current: current[key],
	}));
}

function createMetricRows(baseline: BenchmarkReport, current: BenchmarkReport): MetricRow[] {
	return [
		{ label: "Cold indexing", baseline: baseline.coldIndexMs, current: current.coldIndexMs },
		...distributionRows("Single edit", baseline.singleEditMs, current.singleEditMs),
		...distributionRows("Rapid typing + completion", baseline.rapidTypingMs, current.rapidTypingMs),
		...QUERY_KINDS.flatMap((kind) => [
			...distributionRows(
				`Uncached ${kind}`,
				baseline.uncachedSemanticMs[kind],
				current.uncachedSemanticMs[kind],
			),
			...distributionRows(
				`Warm ${kind}`,
				baseline.warmSemanticMs[kind],
				current.warmSemanticMs[kind],
			),
		]),
	];
}

function formatDuration(value: number): string {
	return `${value.toFixed(2)} ms`;
}

function formatDelta(baseline: number, current: number): string {
	if (baseline === 0) return "n/a (baseline is zero)";
	const delta = ((current - baseline) / Math.abs(baseline)) * 100;
	const prefix = delta > 0 ? "+" : "";
	return `${prefix}${delta.toFixed(1)}%`;
}

function renderComparison(baseline: BenchmarkReport, current: BenchmarkReport): string {
	const sameRuntime =
		baseline.environment.node === current.environment.node &&
		baseline.environment.platform === current.environment.platform &&
		baseline.environment.architecture === current.environment.architecture &&
		baseline.environment.cpuModel === current.environment.cpuModel;
	const sameProjectName = baseline.project.name === current.project.name;
	const sameFileCount = baseline.project.scriptFilesIndexed === current.project.scriptFilesIndexed;
	const sameSourceBytes = baseline.project.sourceBytesIndexed === current.project.sourceBytesIndexed;
	const bothGodotVersionsKnown =
		baseline.project.godotVersion !== undefined && current.project.godotVersion !== undefined;
	const sameGodotVersion =
		bothGodotVersionsKnown && baseline.project.godotVersion === current.project.godotVersion;
	const godotVersionComparison = (() => {
		if (!bothGodotVersionsKnown) return "unknown (version metadata missing)";
		return sameGodotVersion ? "yes" : "no";
	})();
	const sameProjectWorkload = sameProjectName && sameFileCount && sameSourceBytes;
	const rows = createMetricRows(baseline, current);
	return [
		"# Semantic benchmark comparison",
		"",
		`Baseline captured: ${baseline.capturedAt}`,
		`Current captured:  ${current.capturedAt}`,
		`Project: ${baseline.project.name} → ${current.project.name}`,
		`Godot version: ${baseline.project.godotVersion ?? "not recorded"} → ${current.project.godotVersion ?? "not recorded"}`,
		`Indexed GDScript files: ${baseline.project.scriptFilesIndexed} → ${current.project.scriptFilesIndexed}`,
		`Indexed source bytes: ${baseline.project.sourceBytesIndexed} → ${current.project.sourceBytesIndexed}`,
		`Comparable runtime: ${sameRuntime ? "yes" : "no"} (Node, OS, architecture, and CPU model)`,
		`Comparable project shape: ${sameProjectWorkload ? "yes" : "no"} (project name, indexed file count, and source bytes)`,
		`Comparable Godot version: ${godotVersionComparison}`,
		"",
		"Positive delta means the current run took longer; negative delta means it was faster.",
		"",
		"| Metric | Baseline | Current | Change |",
		"| --- | ---: | ---: | ---: |",
		...rows.map(
			(row) =>
				`| ${row.label} | ${formatDuration(row.baseline)} | ${formatDuration(row.current)} | ${formatDelta(row.baseline, row.current)} |`,
		),
		"",
		"Compare latency deltas only after considering runtime and workload differences. These are standalone local semantic metrics, not end-to-end editor latency or Godot LSP fallback counts.",
	].join("\n");
}

const args = process.argv.slice(2);
const baselinePath = args[0];
const currentPath = args[1];
if (args.length !== 2 || baselinePath === undefined || currentPath === undefined) usage();
const baseline = readReport(baselinePath);
const current = readReport(currentPath);
process.stdout.write(`${renderComparison(baseline, current)}\n`);
