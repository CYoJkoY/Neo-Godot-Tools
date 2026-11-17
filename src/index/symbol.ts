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
	return extractDocumentationFromLines(withoutStrings(source).split(/\r?\n/), line);
}

const SCRIPT_DOCUMENTATION_LINE = /^\s*##(.*)$/;
const COMMENTS_AND_STRINGS = /#[^\r\n]*|"""(?:\\[\s\S]|(?!""")[^\\])*(?:"""|$)|'''(?:\\[\s\S]|(?!''')[^\\])*(?:'''|$)|"(?:\\(?:\r\n|[\s\S])|[^"\\\r\n])*"?|'(?:\\(?:\r\n|[\s\S])|[^'\\\r\n])*'?/g;

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

/**
 * Blank out multi-line string contents so `##` inside a string is not read as a
 * comment. Line breaks survive, which keeps line numbers aligned with the file.
 */
function withoutStrings(source: string): string {
	return source.replace(COMMENTS_AND_STRINGS, (text) =>
		text.startsWith("#") ? text : text.replace(/[^\r\n]/g, " "),
	);
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
	firstMember: GDScriptDeclaration | undefined,
): string | undefined {
	const groupLine = lines.findIndex((text) => /^\s*@(?:export_group|export_category|export_subgroup)\b/.test(text));
	const limit = Math.min(firstMember?.range.start.line ?? lines.length, groupLine === -1 ? lines.length : groupLine);
	const start = lines.findIndex((text, index) => index < limit && SCRIPT_DOCUMENTATION_LINE.test(text));
	if (start === -1) return undefined;
	const end = lines.findIndex((text, index) => index > start && !SCRIPT_DOCUMENTATION_LINE.test(text));
	const documentationEndLine = end === -1 ? limit - 1 : end - 1;
	// A block that ends right before the first member documents that member, not
	// the script. Annotations belong to the declaration, so the block also stops
	// documenting the script when it ends just before them. The parser reports
	// where the decorating annotations start because one can span several lines.
	// A member that carries its own trailing `##` comment keeps the block as the
	// script description, which is what Godot's parser does.
	if (firstMember !== undefined) {
		const memberStart = firstMember.annotationStartLine ?? firstMember.range.start.line;
		const memberLine = lines[firstMember.range.start.line];
		const inlineDocumentation = /^[^#]*##/.test(memberLine ?? "");
		if (documentationEndLine + 1 === memberStart && !inlineDocumentation) return undefined;
	}
	const parts = lines.slice(start, documentationEndLine + 1).map((text) =>
		(text.match(SCRIPT_DOCUMENTATION_LINE)?.[1] ?? "").replace(/^ /, "").trimEnd(),
	);
	const documentation = parts.join("\n").replace(/\s+$/, "");
	return documentation.length > 0 ? documentation : undefined;
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
		const documentationLine = declaration.annotationStartLine ?? declaration.range.start.line;
		const documentation = sourceLines
			? extractDocumentationFromLines(sourceLines, documentationLine)
			: extractDocumentation(source, documentationLine);
		if (documentation !== undefined) symbol.documentation = documentation;
	}
	return symbol;
}

export function collectSymbols(ast: GDScriptScript, uri: string, source?: string): IndexedSymbol[] {
	const symbols: IndexedSymbol[] = [];
	// Split once per file. Splitting in declarationToSymbol made symbol collection
	// quadratic for scripts with many methods and documentation comments.
	const sourceLines = source === undefined ? undefined : withoutStrings(source).split(/\r?\n/);
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
	if (className === undefined || className.documentation !== undefined) return;
	const firstMember = ast.declarations.find(
		(declaration) =>
			declaration.kind !== "class_name" &&
			declaration.kind !== "extends" &&
			/\S/.test(sourceLines[declaration.range.start.line]?.[declaration.range.start.character] ?? ""),
	);
	const documentation = extractScriptDocumentation(sourceLines, firstMember);
	if (documentation !== undefined) className.documentation = documentation;
}
