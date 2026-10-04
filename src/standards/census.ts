/**
 * Census of the constructs the coding standard limits.
 *
 * `docs/coding-standards.md` allows classes that the VS Code API requires and
 * loops with a measured justification, but neither may grow. This module turns a
 * source file into counts so `tools/check_standards.ts` can compare the
 * repository against `tools/standards_baseline.json`: the numbers may fall,
 * never rise.
 *
 * The scanner is textual on purpose — a compiler parse would be exact but heavy,
 * and the ratchet only needs a stable, explainable number. Comments and string
 * literals are stripped first, so prose about `for` or `class` does not count,
 * and the JavaScript embedded in the resource inspector's webview template
 * literal stays out of the census entirely.
 */

export type RuleId = "class" | "else" | "for" | "let" | "throw" | "while";

export const RULE_IDS: readonly RuleId[] = ["class", "else", "for", "let", "throw", "while"];

export type RuleCounts = Readonly<Record<RuleId, number>>;

export interface FileCensus {
	readonly counts: RuleCounts;
	/** Loops carried by a `// perf:` justification instead of the raw count. */
	readonly perf: number;
}

export type StandardsBaseline = Readonly<Record<string, FileCensus>>;

export interface SourceFile {
	readonly path: string;
	readonly source: string;
}

export type RegressionRule = RuleId | "perf" | "new-file";

export interface Regression {
	readonly path: string;
	readonly rule: RegressionRule;
	readonly baseline: number;
	readonly current: number;
}

const PATTERNS: Readonly<Record<RuleId, RegExp>> = {
	class: /^\s*(?:export\s+)?(?:abstract\s+)?class\s/,
	else: /\}\s*else\b/,
	for: /\bfor\s*\(/,
	let: /\b(?:let|var)\s+[A-Za-z_$]/,
	throw: /\bthrow\b/,
	while: /\b(?:while|do)\s*[({]/,
};

const PERF_ANNOTATION = /\/\/\s*perf:\s*\S/;

const ZERO_COUNTS: RuleCounts = { class: 0, else: 0, for: 0, let: 0, throw: 0, while: 0 };

interface ScanState {
	readonly inBlockComment: boolean;
	readonly inTemplate: boolean;
	readonly perfPending: boolean;
	readonly counts: RuleCounts;
	readonly perf: number;
}

const INITIAL_STATE: ScanState = {
	inBlockComment: false,
	inTemplate: false,
	perfPending: false,
	counts: ZERO_COUNTS,
	perf: 0,
};

/** Removes quoted string literals; keywords inside them are not code. */
const stripStrings = (text: string): string => text.replace(/"(?:[^"\\]|\\.)*"|'(?:[^'\\]|\\.)*'/g, "");

const countMatches = (text: string, pattern: RegExp): number =>
	text.match(new RegExp(pattern.source, "g"))?.length ?? 0;

const backticksIn = (text: string): number => countMatches(text, /`/);

const countLine = (code: string): RuleCounts => ({
	class: countMatches(code, PATTERNS.class),
	else: countMatches(code, PATTERNS.else),
	for: countMatches(code, PATTERNS.for),
	let: countMatches(code, PATTERNS.let),
	throw: countMatches(code, PATTERNS.throw),
	while: countMatches(code, PATTERNS.while),
});

const addCounts = (base: RuleCounts, extra: RuleCounts): RuleCounts => ({
	class: base.class + extra.class,
	else: base.else + extra.else,
	for: base.for + extra.for,
	let: base.let + extra.let,
	throw: base.throw + extra.throw,
	while: base.while + extra.while,
});

/** Adds the constructs of one code segment, moving justified loops to `perf`. */
const addCode = (state: ScanState, text: string, perfPending: boolean): ScanState => {
	const code = stripStrings(text);
	const found = countLine(code);
	const merge = (counts: RuleCounts): RuleCounts => addCounts(state.counts, counts);
	const loops = found.for + found.while;
	if (perfPending && loops > 0) {
		return {
			...state,
			counts: merge({ ...found, for: 0, while: 0 }),
			perf: state.perf + loops,
			perfPending: false,
		};
	}
	// A `// perf:` line may be followed by blank or comment-only lines before its loop.
	return { ...state, counts: merge(found), perfPending: perfPending && code.trim().length === 0 };
};

/** Counts `text`, which may open or close a template literal. */
const addCodeWithTemplates = (state: ScanState, text: string, perfPending: boolean): ScanState => {
	const open = text.indexOf("`");
	if (open === -1) return addCode(state, text, perfPending);
	const closed = backticksIn(text) % 2 === 0;
	const next = addCode({ ...state, inTemplate: !closed }, text.slice(0, open), perfPending);
	return closed ? addCodeWithTemplates(next, text.slice(text.lastIndexOf("`") + 1), false) : next;
};

const analyseLine = (state: ScanState, line: string): ScanState => {
	if (state.inTemplate) {
		const close = line.lastIndexOf("`");
		return close === -1 ? state : analyseLine({ ...state, inTemplate: false }, line.slice(close + 1));
	}
	if (state.inBlockComment) {
		const end = line.indexOf("*/");
		return end === -1 ? state : analyseLine({ ...state, inBlockComment: false }, line.slice(end + 2));
	}

	const lineCommentAt = line.indexOf("//");
	const blockCommentAt = line.indexOf("/*");
	const blockFirst = blockCommentAt !== -1 && (lineCommentAt === -1 || blockCommentAt < lineCommentAt);
	if (!blockFirst) {
		const at = lineCommentAt === -1 ? line.length : lineCommentAt;
		const comment = line.slice(at);
		return addCodeWithTemplates(state, line.slice(0, at), state.perfPending || PERF_ANNOTATION.test(comment));
	}

	const code = addCodeWithTemplates(state, line.slice(0, blockCommentAt), state.perfPending);
	const close = line.indexOf("*/", blockCommentAt + 2);
	if (close === -1) return { ...code, inBlockComment: true };
	return analyseLine({ ...code, inBlockComment: false }, line.slice(close + 2));
};

export const censusSource = (source: string): FileCensus => {
	const scanned = source.split(/\r?\n/).reduce(analyseLine, INITIAL_STATE);
	return { counts: scanned.counts, perf: scanned.perf };
};

export const violationTotal = (census: FileCensus): number =>
	RULE_IDS.reduce((sum, rule) => sum + census.counts[rule], 0);

export const censusSources = (files: readonly SourceFile[]): StandardsBaseline =>
	Object.fromEntries(files.map((file) => [file.path, censusSource(file.source)]));

/** Rules whose count dropped, for the progress line of the report. */
export const improvements = (baseline: StandardsBaseline, current: StandardsBaseline): number =>
	Object.keys(current).reduce(
		(sum, path) =>
			sum +
			RULE_IDS.filter((rule) => current[path].counts[rule] < (baseline[path]?.counts[rule] ?? 0)).length +
			(current[path].perf < (baseline[path]?.perf ?? 0) ? 1 : 0),
		0,
	);

export const findRegressions = (baseline: StandardsBaseline, current: StandardsBaseline): readonly Regression[] => {
	const paths = [...new Set([...Object.keys(baseline), ...Object.keys(current)])].sort();
	return paths.flatMap((path): readonly Regression[] => {
		const before = baseline[path];
		const now = current[path];
		if (!now) return [];
		if (!before) {
			return violationTotal(now) === 0 && now.perf === 0
				? []
				: [{ path, rule: "new-file" as const, baseline: 0, current: violationTotal(now) }];
		}
		const raised = RULE_IDS.flatMap((rule) =>
			now.counts[rule] > before.counts[rule]
				? [{ path, rule, baseline: before.counts[rule], current: now.counts[rule] }]
				: [],
		);
		const perfRaised =
			now.perf > before.perf ? [{ path, rule: "perf" as const, baseline: before.perf, current: now.perf }] : [];
		return [...raised, ...perfRaised];
	});
};

const isRecord = (value: unknown): value is Record<string, unknown> =>
	typeof value === "object" && value !== null && !Array.isArray(value);

const isRuleCounts = (value: unknown): value is RuleCounts =>
	isRecord(value) && RULE_IDS.every((rule) => typeof value[rule] === "number");

/** Validates the JSON baseline; `JSON.parse` returns `unknown` values we must check. */
export const isStandardsBaseline = (value: unknown): value is StandardsBaseline =>
	isRecord(value) &&
	Object.values(value).every(
		(entry) => isRecord(entry) && isRuleCounts(entry["counts"]) && typeof entry["perf"] === "number",
	);
