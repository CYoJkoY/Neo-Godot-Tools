import type { GDScriptDeclaration, GDScriptDiagnostic, GDScriptScript, SourceRange } from "../analyzer/index.js";

export interface IndexedParameter {
	name: string;
	type?: string;
	defaultValue?: string;
}

export type IndexedSymbolKind =
	| "class"
	| "class_name"
	| "extends"
	| "signal"
	| "enum"
	| "enum_member"
	| "constant"
	| "variable"
	| "function";

export interface IndexedSymbol {
	name: string;
	kind: IndexedSymbolKind;
	uri: string;
	range: SourceRange;
	/** Offset of the declaring identifier inside `range`. */
	nameOffset?: number;
	containerName?: string;
	/** Range of the enclosing class declaration, for nested declarations. */
	containerRange?: SourceRange;
	/** Base class of an inner `class X extends Y:` declaration. */
	extendsName?: string;
	returnType?: string;
	type?: string;
	parameters?: IndexedParameter[];
	static?: boolean;
	/** Contents of the `#`/`##` documentation comments attached to the declaration. */
	documentation?: string;
}

export interface IndexedFile {
	uri: string;
	version: number;
	source: string;
	sourceFingerprint: string;
	ast: GDScriptScript;
	diagnostics: GDScriptDiagnostic[];
	symbols: IndexedSymbol[];
	apiFingerprint: string;
}

/**
 * Returns the `#`/`##` documentation comment block written above `line`.
 *
 * Annotation lines (`@export`, `@onready`, ...) may sit between the comments and
 * the declaration, so they are skipped while walking upwards.
 */
export function extractDocumentation(source: string, line: number): string | undefined {
	return extractDocumentationFromLines(source.split(/\r?\n/), line);
}

const DOCUMENTATION_LINE = /^\s*##(?!#)(.*)$/;
const ANNOTATION_LINE = /^\s*@/;

function extractDocumentationFromLines(lines: readonly string[], line: number): string | undefined {
	if (line <= 0) return undefined;
	const parts: string[] = [];
	for (let candidate = line - 1; candidate >= 0; candidate--) {
		const text = lines[candidate];
		if (text === undefined) continue;
		if (/^\s*@/.test(text)) continue;
		// One or two hashes start a documentation line; `###` and longer are
		// separators or commented-out code and must not leak into the hover.
		const match = text.match(/^\s*#{1,2}(?!#)(.*)$/);
		if (!match) break;
		parts.unshift(match[1].replace(/^ /, "").trimEnd());
	}
	if (!parts.length) return undefined;
	const documentation = parts.join("\n").replace(/\s+$/, "");
	return documentation.length ? documentation : undefined;
}

/** Text of the `##` run from `start` to `end`, both included. */
function documentationText(lines: readonly string[], start: number, end: number): string | undefined {
	const parts = lines.slice(start, end + 1).map((text) => {
		const match = text.match(DOCUMENTATION_LINE);
		return (match?.[1] ?? "").replace(/^ /, "").trimEnd();
	});
	const documentation = parts.join("\n").replace(/\s+$/, "");
	return documentation.length ? documentation : undefined;
}

/**
 * End of the `##` run that starts at `start`.
 *
 * Only the first documentation line of a file can describe the script, and a
 * documentation block is a run of adjacent lines, so the run is walked forward
 * instead of collecting every block in the file.
 */
function documentationEnd(lines: readonly string[], start: number): number {
	const following = lines.findIndex((text, index) => index > start && !DOCUMENTATION_LINE.test(text));
	return following === -1 ? lines.length - 1 : following - 1;
}

/**
 * The `##` block that documents the script itself.
 *
 * Godot's parser treats the first documentation block of a file as the script
 * description, unless that block is the documentation of a member, in which case
 * the script has no description of its own. `class_name`, `extends` and the
 * annotations of the script are not members, so a block written around them
 * still describes the script.
 */
function extractScriptDocumentation(
	lines: readonly string[],
	firstMemberLine: number | undefined,
): string | undefined {
	const limit = firstMemberLine ?? lines.length;
	const start = lines.findIndex((text, index) => index < limit && DOCUMENTATION_LINE.test(text));
	if (start === -1) return undefined;
	const end = documentationEnd(lines, start);
	// Annotations of the member sit between its documentation and its declaration,
	// which is the only way a block above the first member still documents a member.
	const linesToMember = lines.slice(end + 1, limit);
	if (firstMemberLine !== undefined && linesToMember.every((text) => ANNOTATION_LINE.test(text))) return undefined;
	return documentationText(lines, start, end);
}

export function declarationToSymbol(
	declaration: GDScriptDeclaration,
	uri: string,
	containerName?: string,
	source?: string,
	sourceLines?: readonly string[],
	containerRange?: SourceRange,
): IndexedSymbol | undefined {
	if (!declaration.name || declaration.kind === "extends") return undefined;
	const symbol: IndexedSymbol = {
		name: declaration.name,
		kind: declaration.kind,
		uri,
		range: declaration.range,
		nameOffset: declaration.nameOffset,
		containerName,
		containerRange,
	};
	if (declaration.kind === "class") symbol.extendsName = declaration.extendsName;
	// A signal carries its argument list the same way a function does, and the
	// outline renders both through the shared signature formatter.
	if (declaration.kind === "function" || declaration.kind === "signal") {
		symbol.parameters = declaration.parameters.map((parameter) => ({
			name: parameter.name,
			type: parameter.type,
			defaultValue: parameter.defaultValue,
		}));
	}
	if (declaration.kind === "function") {
		symbol.returnType = declaration.returnType;
		symbol.static = declaration.static;
	}
	if (declaration.kind === "constant" || declaration.kind === "variable") symbol.type = declaration.type;
	if (source) {
		const documentation = sourceLines
			? extractDocumentationFromLines(sourceLines, declaration.range.start.line)
			: extractDocumentation(source, declaration.range.start.line);
		if (documentation) symbol.documentation = documentation;
	}
	return symbol;
}

export function collectSymbols(ast: GDScriptScript, uri: string, source?: string): IndexedSymbol[] {
	const symbols: IndexedSymbol[] = [];
	// Split once per file. Splitting in declarationToSymbol made symbol collection
	// quadratic for scripts with many methods and documentation comments.
	const sourceLines = source?.split(/\r?\n/);
	const visit = (declarations: GDScriptDeclaration[], containerName?: string, containerRange?: SourceRange) => {
		for (const declaration of declarations) {
			if (declaration.kind === "enum") {
				// Named enums are types whose members are only reachable through the
				// enum name; members of unnamed enums act as plain script constants.
				const symbol = declarationToSymbol(
					declaration,
					uri,
					containerName,
					source,
					sourceLines,
					containerRange,
				);
				if (symbol) symbols.push(symbol);
				for (const member of declaration.members) {
					const documentation = sourceLines
						? extractDocumentationFromLines(sourceLines, member.range.start.line)
						: undefined;
					symbols.push({
						name: member.name,
						kind: "enum_member",
						uri,
						range: member.range,
						nameOffset: member.range.start.offset,
						containerName: declaration.name ?? containerName,
						containerRange,
						type: declaration.name,
						...(documentation ? { documentation } : {}),
					});
				}
				continue;
			}
			const symbol = declarationToSymbol(declaration, uri, containerName, source, sourceLines, containerRange);
			if (symbol) symbols.push(symbol);
			if (declaration.kind === "class") visit(declaration.declarations, declaration.name, declaration.range);
		}
	};
	visit(ast.declarations);
	applyScriptDocumentation(symbols, ast, sourceLines);
	return symbols;
}

/**
 * Gives the `class_name` symbol the script description.
 *
 * The block may sit above `class_name`, between `class_name` and `extends`, or
 * after `extends`, which is the layout the Godot documentation shows; walking up
 * from the declaration only reaches the first two. The symbol keeps the
 * documentation it already has, so member-level hovers are unaffected.
 */
function applyScriptDocumentation(
	symbols: IndexedSymbol[],
	ast: GDScriptScript,
	sourceLines: readonly string[] | undefined,
): void {
	if (!sourceLines) return;
	const className = symbols.find((symbol) => symbol.kind === "class_name");
	if (!className || className.documentation) return;
	const firstMember = ast.declarations.find(
		(declaration) => declaration.kind !== "class_name" && declaration.kind !== "extends",
	);
	const documentation = extractScriptDocumentation(sourceLines, firstMember?.range.start.line);
	if (documentation) className.documentation = documentation;
}
