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

function collectLines(source: string, bodyRange: GDScriptFunction["bodyRange"]): LineInfo[] {
	if (!bodyRange) return [];
	const lines = new Map<number, LineInfo>();
	for (const token of lexGDScript(source)) {
		if (token.kind === "eof") break;
		if (token.start < bodyRange.start.offset || token.end > bodyRange.end.offset) continue;
		if (token.kind === "newline") continue;
		const current = lines.get(token.line);
		if (current) {
			current.tokens.push(token);
			current.end = token.end;
		} else {
			lines.set(token.line, {
				line: token.line,
				indent: token.indent,
				start: token.start,
				lineStart: token.start - token.indent,
				end: token.end,
				tokens: [token],
			});
		}
	}
	return [...lines.values()].sort((a, b) => a.line - b.line);
}

function assignment(lines: LineInfo[], name: string, maxOffset: number): string | undefined {
	let result: string | undefined;
	for (const line of lines) {
		if (line.start > maxOffset) break;
		const tokens = line.tokens;
		const nameIndex = tokens[0]?.value === "var" || tokens[0]?.value === "const" ? 1 : 0;
		if (tokens[nameIndex]?.value !== name) continue;
		let equals = nameIndex + 1;
		if (tokens[equals]?.value === ":") {
			equals++;
			while (equals < tokens.length && tokens[equals].value !== "=") equals++;
		}
		const isInferredAssignment = tokens[equals]?.value === ":=";
		if (!isInferredAssignment && tokens[equals]?.value !== "=") continue;
		const expression = tokens.slice(equals + 1).map((token) => token.value).join(" ").trim();
		if (expression) result = expression;
	}
	return result;
}

function blockEnd(lines: LineInfo[], start: number, parentIndent: number): number {
	for (let index = start; index < lines.length; index++) if (lines[index].indent <= parentIndent) return index;
	return lines.length;
}

function branchGroups(lines: LineInfo[]): Array<{ start: number; end: number; branches: Array<{ start: number; end: number; keyword: string }> }> {
	const groups: Array<{ start: number; end: number; branches: Array<{ start: number; end: number; keyword: string }> }> = [];
	for (let index = 0; index < lines.length; index++) {
		if (lines[index].tokens[0]?.value !== "if") continue;
		const indent = lines[index].indent;
		const branches: Array<{ start: number; end: number; keyword: string }> = [];
		let cursor = index;
		while (cursor < lines.length) {
			const keyword = lines[cursor].tokens[0]?.value;
			if ((keyword !== "if" && keyword !== "elif" && keyword !== "else") || lines[cursor].indent !== indent) break;
			const end = blockEnd(lines, cursor + 1, indent);
			branches.push({ start: cursor + 1, end, keyword });
			if (end >= lines.length) { cursor = end; break; }
			const next = lines[end];
			if (next.indent !== indent || !["elif", "else"].includes(next.tokens[0]?.value ?? "")) { cursor = end; break; }
			cursor = end;
		}
		if (branches.length) {
			groups.push({ start: index, end: cursor, branches });
			index = Math.max(index, cursor - 1);
		}
	}
	return groups;
}

/**
 * Returns safe branch assignments. `undefined` means no relevant branch was found;
 * an empty array means relevant control flow exists but its post-branch type is ambiguous.
 */
export function collectControlFlowAssignments(source: string, bodyRange: GDScriptFunction["bodyRange"], name: string, offset: number): string[] | undefined {
	const lines = collectLines(source, bodyRange);
	if (!lines.length) return undefined;

	const lineStart = (lineIndex: number): number => lines[lineIndex]?.lineStart ?? Number.POSITIVE_INFINITY;
	const contentEnd = (lineIndex: number): number => lines[Math.min(lineIndex, lines.length) - 1]?.end ?? Number.NEGATIVE_INFINITY;

	// Post-branch values are collected from the last group that ends before the
	// offset so later assignments win over earlier ones.
	let postValues: string[] | undefined;
	let postMatched = false;

	for (const group of branchGroups(lines)) {
		const groupStart = lineStart(group.start);
		const groupEnd = contentEnd(group.end);
		if (offset < groupStart) continue;

		if (offset >= groupEnd) {
			const values = group.branches.map((branch) => assignment(lines.slice(branch.start, branch.end), name, Number.POSITIVE_INFINITY));
			if (values.some((value) => value !== undefined)) {
				const hasElse = group.branches.some((branch) => branch.keyword === "else");
				postValues = hasElse && values.every((value): value is string => Boolean(value)) ? values : [];
				postMatched = true;
			}
			continue;
		}

		for (const branch of group.branches) {
			const branchStart = lineStart(branch.start);
			// A branch owns everything up to the line that follows its body, so a
			// reference on a dedented line is never attributed to the branch.
			const branchEnd = branch.end < lines.length ? lineStart(branch.end) : Number.POSITIVE_INFINITY;
			if (offset >= branchStart && offset < branchEnd) {
				const value = assignment(lines.slice(branch.start, branch.end), name, offset);
				return value ? [value] : undefined;
			}
		}
	}

	return postMatched ? postValues : undefined;
}
