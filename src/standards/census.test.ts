import { strict as assert } from "node:assert";
import { describe, it } from "node:test";
import {
	type RuleCounts,
	type StandardsBaseline,
	censusSource,
	findRegressions,
	isStandardsBaseline,
	violationTotal,
} from "./census.js";

const NO_COUNTS: RuleCounts = { class: 0, else: 0, for: 0, let: 0, throw: 0, while: 0 };

const withCounts = (counts: Partial<RuleCounts>, perf = 0) => ({ counts: { ...NO_COUNTS, ...counts }, perf });

describe("coding standard census", () => {
	it("counts the limited constructs", () => {
		const census = censusSource(
			[
				"class Holder extends Base {",
				"\tvalue = 1;",
				"}",
				"function run(items: number[]) {",
				"\tlet total = 0;",
				"\tfor (const item of items) total += item;",
				"\twhile (total > 10) total -= 10;",
				"\tif (total > 5) { total--; } else { total++; }",
				'\tif (total < 0) throw new Error("negative");',
				"\treturn total;",
				"}",
			].join("\n"),
		);
		assert.deepEqual(census, withCounts({ class: 1, else: 1, for: 1, let: 1, throw: 1, while: 1 }));
	});

	it("ignores prose, comments and string literals", () => {
		const census = censusSource(
			[
				"/** Explains why a class may use while (true) and for (;;). */",
				"// let the reader decide",
				"export const note = \"throw new Error('for (;;) class')\";",
				"export const raw = 'let value = 1;';",
			].join("\n"),
		);
		assert.equal(violationTotal(census), 0);
	});

	it("keeps template literals out of the census but counts code after them", () => {
		const embedded = censusSource(
			[
				"export const html = `",
				"\t<script>",
				"\t\tlet state = {};",
				"\t\tfor (const node of nodes) render(node);",
				"\t</script>",
				"`;",
			].join("\n"),
		);
		assert.equal(violationTotal(embedded), 0);

		const trailing = censusSource("export const html = `x`;\nlet value = 1;");
		assert.deepEqual(trailing, withCounts({ let: 1 }));
	});

	it("moves loops justified by `// perf:` into the perf column", () => {
		const census = censusSource(
			[
				"// perf: 40k samples, map() allocates per element",
				"for (const sample of samples) accumulate(sample);",
				"for (const rest of others) skip(rest);",
				"while (pending) drain(); // perf: drain is O(1), called per frame",
			].join("\n"),
		);
		assert.equal(census.counts.for, 1);
		assert.equal(census.counts.while, 0);
		assert.equal(census.perf, 2);
	});

	it("flags raised counts and stays quiet about reductions", () => {
		const baseline: StandardsBaseline = { "src/a.ts": withCounts({ for: 2, let: 3 }, 1) };
		assert.deepEqual(findRegressions(baseline, { "src/a.ts": withCounts({ for: 2, let: 3 }, 1) }), []);
		assert.deepEqual(findRegressions(baseline, { "src/a.ts": withCounts({ for: 1, let: 3 }, 1) }), []);
		assert.deepEqual(findRegressions(baseline, {}), []);
		assert.deepEqual(findRegressions(baseline, { "src/b.ts": withCounts({}, 0) }), []);
		assert.deepEqual(findRegressions(baseline, { "src/a.ts": withCounts({ for: 3, let: 3 }, 1) }), [
			{ path: "src/a.ts", rule: "for", baseline: 2, current: 3 },
		]);
		assert.deepEqual(findRegressions(baseline, { "src/a.ts": withCounts({ for: 2, let: 3 }, 2) }), [
			{ path: "src/a.ts", rule: "perf", baseline: 1, current: 2 },
		]);
		assert.deepEqual(findRegressions(baseline, { "src/new.ts": withCounts({ class: 1 }) }), [
			{ path: "src/new.ts", rule: "new-file", baseline: 0, current: 1 },
		]);
	});

	it("validates a parsed baseline", () => {
		assert.equal(isStandardsBaseline({}), true);
		assert.equal(isStandardsBaseline({ "src/a.ts": withCounts({ for: 1 }) }), true);
		assert.equal(isStandardsBaseline({ "src/a.ts": { counts: { class: 0 }, perf: 0 } }), false);
		assert.equal(isStandardsBaseline({ "src/a.ts": 3 }), false);
		assert.equal(isStandardsBaseline([]), false);
		assert.equal(isStandardsBaseline("{}"), false);
	});
});
