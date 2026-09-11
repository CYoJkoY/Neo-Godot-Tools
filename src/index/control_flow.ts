import { GDScriptFunction, GDScriptToken, lexGDScript } from "../analyzer/index.js";

interface LineInfo {
	line: number;
	indent: number;
	start: number;
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
			lines.set(token.line, { line: token.line, indent: token.indent, start: token.start, end: token.end, tokens: [token] });
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
		if (tokens[equals]?.value !== "=") continue;
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
	for (const group of branchGroups(lines)) {
		const groupStart = lines[group.start].start;
		const groupEnd = group.end < lines.length ? lines[group.end].start : Number.POSITIVE_INFINITY;
		if (offset < groupStart || offset > groupEnd) continue;

		for (const branch of group.branches) {
			const branchStart = branch.start < lines.length ? lines[branch.start].start : groupEnd;
			const branchEnd = branch.end < lines.length ? lines[branch.end].start : groupEnd;
			if (offset >= branchStart && offset <= branchEnd) {
				const value = assignment(lines.slice(branch.start, branch.end), name, offset);
				return value ? [value] : undefined;
			}
		}

		if (offset >= groupEnd) {
			const values = group.branches.map((branch) => assignment(lines.slice(branch.start, branch.end), name, Number.POSITIVE_INFINITY));
			const hasRelevantAssignment = values.some((value) => value !== undefined);
			if (!hasRelevantAssignment) return undefined;
			const hasElse = group.branches.some((branch) => branch.keyword === "else");
			if (!hasElse || !values.every((value): value is string => Boolean(value))) return [];
			return values;
		}
	}
	return undefined;
}
