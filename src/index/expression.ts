import type { GDScriptToken } from "../analyzer/index.js";

/**
 * Parsing of GDScript access chains (`Worker.new().run()`, `Outer.Inner.mode`).
 *
 * Go-to-definition and completion need the *type* of the expression in front of
 * a `.`, which is not always an identifier: `Worker.new().run()` receives a call
 * result. Working on the lexer's tokens (instead of regular expressions over the
 * raw text) keeps the parse correct across strings, comments and multi-line
 * argument lists.
 */

export interface ChainLink {
	/** Identifier being accessed. */
	name: string;
	/** True when the identifier is called: `name(...)`. */
	call: boolean;
	/** Offset of the identifier in the source. */
	offset: number;
}

function previousSignificant(tokens: readonly GDScriptToken[], index: number): number {
	let current = index;
	while (current >= 0) {
		const token = tokens[current];
		if (token.kind === "newline" || token.kind === "eof") return -1;
		if (token.kind === "punctuation" && token.value === "\\") {
			// Explicit line continuation keeps the expression going.
			current -= 1;
			continue;
		}
		return current;
	}
	return -1;
}

/** Index of the opening bracket matching the closer at `closeIndex`. */
function matchingOpening(tokens: readonly GDScriptToken[], closeIndex: number): number {
	const closer = tokens[closeIndex].value;
	const opener = closer === ")" ? "(" : closer === "]" ? "[" : "{";
	let depth = 0;
	for (let index = closeIndex; index >= 0; index--) {
		const token = tokens[index];
		if (token.kind !== "punctuation") continue;
		if (token.value === closer) depth += 1;
		else if (token.value === opener) {
			depth -= 1;
			if (depth === 0) return index;
		}
	}
	return -1;
}

/** Index of the token that starts exactly at `offset`, or -1. */
function tokenAt(tokens: readonly GDScriptToken[], offset: number): number {
	let low = 0;
	let high = tokens.length - 1;
	while (low <= high) {
		const middle = (low + high) >> 1;
		const start = tokens[middle].start;
		if (start === offset) return middle;
		if (start < offset) low = middle + 1;
		else high = middle - 1;
	}
	return -1;
}

/** Index of the last token that starts before `offset`, or -1. */
function tokenBefore(tokens: readonly GDScriptToken[], offset: number): number {
	let low = 0;
	let high = tokens.length - 1;
	let result = -1;
	while (low <= high) {
		const middle = (low + high) >> 1;
		if (tokens[middle].start < offset) {
			result = middle;
			low = middle + 1;
		} else {
			high = middle - 1;
		}
	}
	return result;
}

/**
 * The chain of accesses forming the expression that ends at `endOffset`.
 *
 * `endOffset` is exclusive: for `Worker.new().run` resolving `run` passes the
 * offset of the `.` in front of it, and receives `Worker` + `new()`.
 * Returns `undefined` when the expression is not a plain access chain (an
 * index, a literal, a binary operation, …), which keeps the caller from
 * inventing a receiver.
 */
export function parseChainEndingAt(tokens: readonly GDScriptToken[], endOffset: number): ChainLink[] | undefined {
	const links: ChainLink[] = [];
	let index = previousSignificant(tokens, tokenBefore(tokens, endOffset));
	while (index >= 0) {
		const token = tokens[index];
		if (token.kind === "punctuation" && token.value === "]") {
			// `array[index].member`: the element type is unknown.
			return undefined;
		}
		if (token.kind === "punctuation" && token.value === ")") {
			const open = matchingOpening(tokens, index);
			if (open < 0) return undefined;
			const calleeIndex = previousSignificant(tokens, open - 1);
			if (calleeIndex < 0 || tokens[calleeIndex].kind !== "identifier") return undefined;
			links.push({ name: tokens[calleeIndex].value, call: true, offset: tokens[calleeIndex].start });
			index = previousSignificant(tokens, calleeIndex - 1);
			if (index >= 0 && tokens[index].kind === "punctuation" && tokens[index].value === ".") {
				index = previousSignificant(tokens, index - 1);
				continue;
			}
			break;
		}
		if (token.kind === "identifier") {
			links.push({ name: token.value, call: false, offset: token.start });
			index = previousSignificant(tokens, index - 1);
			if (index >= 0 && tokens[index].kind === "punctuation" && tokens[index].value === ".") {
				index = previousSignificant(tokens, index - 1);
				continue;
			}
			break;
		}
		return undefined;
	}
	if (!links.length) return undefined;
	return links.reverse();
}

/**
 * The `.` token immediately in front of `offset`, if any. Unlike
 * {@link memberAccessDot} this does not require an identifier at `offset`,
 * which is what completion needs while the member name is still empty.
 */
export function dotBefore(tokens: readonly GDScriptToken[], offset: number): GDScriptToken | undefined {
	const index = tokenBefore(tokens, offset);
	if (index < 0) return undefined;
	const token = tokens[index];
	return token.kind === "punctuation" && token.value === "." ? token : undefined;
}

/** True when the expression behind the dot at `dotOffset` starts a statement. */
export function startsStatement(tokens: readonly GDScriptToken[], dotOffset: number): boolean {
	const index = tokenBefore(tokens, dotOffset);
	if (index < 0) return true;
	const token = tokens[index];
	return token.kind === "newline" || token.kind === "eof" || (token.kind === "punctuation" && (token.value === ":" || token.value === "{"));
}

/**
 * True when the identifier at `offset` is accessed through a `.`, and returns
 * the offset of that dot. `self.run()` and `Worker.new().run()` both qualify.
 */
export function memberAccessDot(tokens: readonly GDScriptToken[], offset: number): number | undefined {
	const index = tokenAt(tokens, offset);
	if (index <= 0 || tokens[index].kind !== "identifier") return undefined;
	const previous = tokens[index - 1];
	return previous.kind === "punctuation" && previous.value === "." ? previous.start : undefined;
}
