/**
 * Collation contract shared with `backend/src/symbol_index.zig`.
 *
 * `localeCompare` orders printable ASCII punctuation first, then digits, then
 * letters with both cases on one primary weight. The native index reproduces
 * that order, but ICU data differs between hosts, so the order is compared with
 * the host collator before the native fast path is enabled.
 */

/** Printable ASCII punctuation in its collation order; digits and letters follow. */
export const ASCII_PUNCTUATION_ORDER = " _-,;:!?.'\"()[]{}@*/\\&#%`^+<=>|~$";

const PUNCTUATION_RANK = new Map(
	Array.from(ASCII_PUNCTUATION_ORDER, (character, rank) => [character, rank] as const),
);
const DIGIT_BASE = ASCII_PUNCTUATION_ORDER.length;
const LETTER_BASE = DIGIT_BASE + 10;

const primaryRank = (code: number): number => {
	const punctuation = PUNCTUATION_RANK.get(String.fromCharCode(code));
	if (punctuation !== undefined) return punctuation;
	if (code >= 48 && code <= 57) return DIGIT_BASE + code - 48;
	if (code >= 65 && code <= 90) return LETTER_BASE + code - 65;
	if (code >= 97 && code <= 122) return LETTER_BASE + code - 97;
	return LETTER_BASE + 26 + code;
};

/** True for every UTF-16 unit in the printable ASCII range. */
export const isPrintableAscii = (value: string): boolean =>
	Array.from(value, (character) => character.charCodeAt(0)).every((code) => code >= 0x20 && code <= 0x7e);

const firstDifference = (left: readonly number[], right: readonly number[]): number => {
	const shared = Math.min(left.length, right.length);
	return (
		Array.from({ length: shared }, (_value, index) => index).find((index) => left[index] !== right[index]) ?? -1
	);
};

/** Mirrors the Zig comparator for printable ASCII; non-ASCII input never reaches it. */
export const compareAscii = (left: string, right: string): number => {
	const leftRanks = Array.from(left, (character) => primaryRank(character.charCodeAt(0)));
	const rightRanks = Array.from(right, (character) => primaryRank(character.charCodeAt(0)));
	const primary = firstDifference(leftRanks, rightRanks);
	if (primary !== -1) return (leftRanks[primary] ?? 0) - (rightRanks[primary] ?? 0);
	if (left.length !== right.length) return left.length - right.length;

	const leftCodes = Array.from(left, (character) => character.charCodeAt(0));
	const rightCodes = Array.from(right, (character) => character.charCodeAt(0));
	const differing = firstDifference(leftCodes, rightCodes);
	if (differing === -1) return 0;
	const leftCode = leftCodes[differing] ?? 0;
	const rightCode = rightCodes[differing] ?? 0;
	const leftLower = leftCode >= 97 && leftCode <= 122 ? 0 : 1;
	const rightLower = rightCode >= 97 && rightCode <= 122 ? 0 : 1;
	return leftLower - rightLower || leftCode - rightCode;
};

const consecutivePairs = (characters: readonly string[]): readonly (readonly [string, string])[] =>
	characters
		.slice(0, -1)
		.map((character, index): readonly [string, string] => [character, characters[index + 1] ?? character]);

/** The last entry of the punctuation table, which sorts before the first digit. */
const lastPunctuation = ASCII_PUNCTUATION_ORDER.charAt(ASCII_PUNCTUATION_ORDER.length - 1);

/**
 * Every consecutive pair of the punctuation table, then the boundaries that
 * separate the punctuation, digit and letter blocks. Probing the table itself
 * keeps it honest as it grows, instead of checking a few hand-picked pairs.
 */
const orderProbes: readonly (readonly [string, string])[] = [
	...consecutivePairs(Array.from(ASCII_PUNCTUATION_ORDER)),
	[lastPunctuation, "0"],
	["9", "a"],
	["z", "A"],
];

/** Boundary probes plus the identifier and case pairs the native comparator must reproduce. */
const probePairs: readonly (readonly [string, string])[] = [
	...orderProbes,
	["I", "i"],
	["script_10", "script_2"],
	["get_value", "getValue"],
	["HTTPRequest", "http_request"],
	["__init__", "_init"],
	["a-b", "a_b"],
	["A", "a"],
	["a", "B"],
];

const collatorMatches = (): boolean => {
	const collator = new Intl.Collator();
	return probePairs.every(
		([left, right]) =>
			isPrintableAscii(left) &&
			isPrintableAscii(right) &&
			Math.sign(collator.compare(left, right)) === Math.sign(compareAscii(left, right)),
	);
};

const probe = { value: undefined as boolean | undefined };

/**
 * True when the host collator agrees with the native ordering for the probe
 * set. A `tr-TR` host fails the `I`/`i` pair and keeps the TypeScript path.
 */
export const asciiCollationSupported = (): boolean => {
	probe.value ??= collatorMatches();
	return probe.value;
};
