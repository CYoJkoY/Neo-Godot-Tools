import { GDScriptFunction, GDScriptToken, lexGDScript } from "../analyzer/index.js";

interface LineInfo {
	line: number;
	indent: number;
	/** Offset of the first non-whitespace token on the line. */
	start: number;
	/** Offset of the line itself, including its leading indentation. */
	lineStart: number;
	end: number;
	tokens: GDScriptToken[];
}

interface FlowBranch {
	start: number;
	end: number;
	keyword: string;
}

interface FlowGroup {
	start: number;
	end: number;
	branches: FlowBranch[];
}

/** Tokens of `bodyRange` grouped by line, in source order. */
function collectLines(source: string, bodyRange: GDScriptFunction["bodyRange"]): LineInfo[] {
	if (!bodyRange) return [];
	const tokens = lexGDScript(source).filter(
		(token) =>
			token.kind !== "eof" &&
			token.kind !== "newline" &&
			token.start >= bodyRange.start.offset &&
			token.end <= bodyRange.end.offset,
	);
	const byLine = new Map<number, GDScriptToken[]>();
	tokens.map((token) => {
		const line = byLine.get(token.line) ?? [];
		line.push(token);
		byLine.set(token.line, line);
	});
	return [...byLine].map(([line, lineTokens]) => ({
		line,
		indent: lineTokens[0].indent,
		start: lineTokens[0].start,
		lineStart: lineTokens[0].start - lineTokens[0].indent,
		end: lineTokens[lineTokens.length - 1].end,
		tokens: lineTokens,
	}));
}

/** Token index of the `=` that assigns to the name starting at `nameIndex`. */
function equalsIndex(tokens: GDScriptToken[], nameIndex: number): number {
	if (tokens[nameIndex + 1]?.value !== ":") return nameIndex + 1;
	const found = tokens.findIndex((token, index) => index > nameIndex + 1 && token.value === "=");
	return found === -1 ? tokens.length : found;
}

/** Expression assigned to `name` on this line, when the line assigns to it. */
function assignedExpression(tokens: GDScriptToken[], name: string): string | undefined {
	const nameIndex = tokens[0]?.value === "var" || tokens[0]?.value === "const" ? 1 : 0;
	if (tokens[nameIndex]?.value !== name) return undefined;
	const equals = equalsIndex(tokens, nameIndex);
	if (tokens[equals]?.value !== ":=" && tokens[equals]?.value !== "=") return undefined;
	const expression = tokens
		.slice(equals + 1)
		.map((token) => token.value)
		.join(" ")
		.trim();
	return expression || undefined;
}

function assignment(lines: LineInfo[], name: string, maxOffset: number): string | undefined {
	return lines
		.filter((line) => line.start <= maxOffset)
		.map((line) => assignedExpression(line.tokens, name))
		.filter((expression) => expression !== undefined)
		.at(-1);
}

/** First line at or after `start` that dedents out of the block, or `lines.length`. */
function blockEnd(lines: LineInfo[], start: number, parentIndent: number): number {
	const index = lines.findIndex((line, position) => position >= start && line.indent <= parentIndent);
	return index === -1 ? lines.length : index;
}

/** Line indexes of the `if`/`elif`/`else` keywords chained at one indentation. */
function branchStarts(lines: LineInfo[], start: number, indent: number): number[] {
	const end = blockEnd(lines, start + 1, indent);
	const next = lines[end];
	const keyword = next?.tokens[0]?.value ?? "";
	if (next?.indent !== indent || (keyword !== "elif" && keyword !== "else")) return [start];
	return [start, ...branchStarts(lines, end, indent)];
}

/** The `if`/`elif`/`else` chain that starts on the `if` line at `start`. */
function branchGroupAt(lines: LineInfo[], start: number): FlowGroup {
	const indent = lines[start].indent;
	const branches = branchStarts(lines, start, indent).map((line) => ({
		start: line + 1,
		end: blockEnd(lines, line + 1, indent),
		keyword: lines[line].tokens[0]?.value ?? "",
	}));
	return { start, end: branches[branches.length - 1].end, branches };
}

/** Branch chains in source order; a chain never starts inside an earlier chain. */
function branchGroups(lines: LineInfo[]): FlowGroup[] {
	return lines.reduce<FlowGroup[]>((groups, line, index) => {
		if (line.tokens[0]?.value !== "if") return groups;
		// A chain owns `[start, end)`; the line at `end` may start the next chain.
		if (groups.some((group) => index >= group.start && index < group.end)) return groups;
		groups.push(branchGroupAt(lines, index));
		return groups;
	}, []);
}

/** Values a whole branch chain assigns, or `undefined` when it assigns nothing. */
function branchValues(group: FlowGroup, lines: LineInfo[], name: string): string[] | undefined {
	const values = group.branches.map((branch) =>
		assignment(lines.slice(branch.start, branch.end), name, Number.POSITIVE_INFINITY),
	);
	if (!values.some((value) => value !== undefined)) return undefined;
	const hasElse = group.branches.some((branch) => branch.keyword === "else");
	return hasElse && values.every((value): value is string => Boolean(value)) ? values : [];
}

/**
 * Returns safe branch assignments. `undefined` means no relevant branch was found;
 * an empty array means relevant control flow exists but its post-branch type is ambiguous.
 */
export function collectControlFlowAssignments(
	source: string,
	bodyRange: GDScriptFunction["bodyRange"],
	name: string,
	offset: number,
): string[] | undefined {
	const lines = collectLines(source, bodyRange);
	if (!lines.length) return undefined;

	const lineStart = (lineIndex: number): number => lines[lineIndex]?.lineStart ?? Number.POSITIVE_INFINITY;
	const contentEnd = (lineIndex: number): number =>
		lines[Math.min(lineIndex, lines.length) - 1]?.end ?? Number.NEGATIVE_INFINITY;

	const groups = branchGroups(lines);
	const branchEnd = (branch: FlowBranch): number =>
		branch.end < lines.length ? lineStart(branch.end) : Number.POSITIVE_INFINITY;

	// Post-branch values are collected from every chain that ends before the
	// offset, so later assignments win over earlier ones.
	const completed = groups
		.filter((group) => offset >= contentEnd(group.end))
		.map((group) => branchValues(group, lines, name))
		.filter((values) => values !== undefined);

	const containing = groups.find((group) => offset >= lineStart(group.start) && offset < contentEnd(group.end));
	if (containing) {
		// A branch owns everything up to the line that follows its body, so a
		// reference on a dedented line is never attributed to the branch.
		const branch = containing.branches.find((item) => offset >= lineStart(item.start) && offset < branchEnd(item));
		if (branch) {
			const value = assignment(lines.slice(branch.start, branch.end), name, offset);
			return value ? [value] : undefined;
		}
	}
	return completed.at(-1);
}
