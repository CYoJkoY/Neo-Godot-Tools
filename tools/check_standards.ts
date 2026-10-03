/**
 * Coding standard ratchet.
 *
 * `docs/coding-standards.md` binds new and modified code, while the rest of the
 * repository migrates module by module. This checker keeps that honest: it
 * counts the limited constructs across `src` and `tools`, compares them with
 * `tools/standards_baseline.json`, and fails when a count grows. Counts may only
 * fall; `--update` refreshes the baseline after a deliberate reduction.
 *
 * Textual census rules live in `src/standards/census.ts` and are unit tested
 * there; this file only walks the tree, reads the baseline and reports.
 */

import * as fs from "node:fs";
import * as path from "node:path";
import {
	type FileCensus,
	type Regression,
	type SourceFile,
	type StandardsBaseline,
	censusSources,
	findRegressions,
	improvements,
	isStandardsBaseline,
	violationTotal,
} from "../src/standards/census.js";

const ROOT = path.resolve(__dirname, "..");
const BASELINE_PATH = path.join(ROOT, "tools", "standards_baseline.json");
const SCAN_DIRECTORIES: readonly string[] = ["src", "tools"];

const readSourceFiles = (directory: string): readonly SourceFile[] =>
	fs.readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
		const full = path.join(directory, entry.name);
		if (entry.isDirectory()) return readSourceFiles(full);
		if (!entry.name.endsWith(".ts")) return [];
		const relative = path.relative(ROOT, full).split(path.sep).join("/");
		return [{ path: relative, source: fs.readFileSync(full, "utf8") }];
	});

const sortedByPath = (baseline: StandardsBaseline): StandardsBaseline =>
	Object.fromEntries(Object.entries(baseline).sort(([left], [right]) => left.localeCompare(right)));

const readBaseline = (): StandardsBaseline | undefined => {
	if (!fs.existsSync(BASELINE_PATH)) return undefined;
	const parsed: unknown = JSON.parse(fs.readFileSync(BASELINE_PATH, "utf8"));
	return isStandardsBaseline(parsed) ? parsed : undefined;
};

const sum = (values: readonly number[]): number => values.reduce((total, value) => total + value, 0);

const describe = (regression: Regression): string =>
	`  ${regression.path}: ${regression.rule} ${regression.baseline} -> ${regression.current}`;

const updateBaseline = (current: StandardsBaseline): void => {
	fs.writeFileSync(BASELINE_PATH, `${JSON.stringify(sortedByPath(current), undefined, "\t")}\n`);
	console.log(`Baseline updated: ${path.relative(ROOT, BASELINE_PATH)}`);
};

const verify = (current: StandardsBaseline, exempted: number): number => {
	const baseline = readBaseline();
	if (!baseline) {
		console.error(
			`Missing or invalid ${path.relative(ROOT, BASELINE_PATH)}; run "npm run check:standards -- --update" to recreate it.`,
		);
		return 1;
	}

	const totals = sum(Object.values(current).map(violationTotal));
	const regressions = findRegressions(baseline, current);
	console.log(
		`Coding standard census: ${totals} tracked constructs in ${Object.keys(current).length} files ` +
			`(${exempted} justified with "// perf:", ${improvements(baseline, current)} rules improved).`,
	);

	if (!regressions.length) return 0;
	console.error(
		[
			`Coding standard regression in ${regressions.length} place(s) (docs/coding-standards.md):`,
			...regressions.map(describe),
			'New and modified code must be clean; measured hot paths use a "// perf: <reason>" comment.',
		].join("\n"),
	);
	return 1;
};

const files = SCAN_DIRECTORIES.flatMap(readSourceFiles);
const current = censusSources(files);
const exempted = sum(Object.values(current).map((census: FileCensus) => census.perf));

if (process.argv.includes("--update")) {
	updateBaseline(current);
	process.exitCode = 0;
} else {
	process.exitCode = verify(current, exempted);
}
