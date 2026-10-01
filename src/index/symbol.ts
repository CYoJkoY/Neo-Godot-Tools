import {
	GDScriptDeclaration,
	GDScriptDiagnostic,
	GDScriptFunction,
	GDScriptScript,
	SourceRange,
} from "../analyzer/index.js";

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
	containerName?: string;
	returnType?: string;
	type?: string;
	parameters?: IndexedParameter[];
	static?: boolean;
	/** Contents of the `##` documentation comments attached to the declaration. */
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
 * Returns the `##` documentation comment block written above `line`.
 *
 * Annotation lines (`@export`, `@onready`, ...) may sit between the comments and
 * the declaration, so they are skipped while walking upwards.
 */
export function extractDocumentation(source: string, line: number): string | undefined {
	return extractDocumentationFromLines(source.split(/\r?\n/), line);
}

function extractDocumentationFromLines(lines: readonly string[], line: number): string | undefined {
	if (line <= 0) return undefined;
	const parts: string[] = [];
	for (let candidate = line - 1; candidate >= 0; candidate--) {
		const text = lines[candidate];
		if (text === undefined) continue;
		if (/^\s*@/.test(text)) continue;
		const match = text.match(/^\s*##(.*)$/);
		if (!match) break;
		parts.unshift(match[1].replace(/^ /, "").trimEnd());
	}
	if (!parts.length) return undefined;
	const documentation = parts.join("\n").replace(/\s+$/, "");
	return documentation.length ? documentation : undefined;
}

export function declarationToSymbol(
	declaration: GDScriptDeclaration,
	uri: string,
	containerName?: string,
	source?: string,
	sourceLines?: readonly string[],
): IndexedSymbol | undefined {
	if (!declaration.name || declaration.kind === "extends") return undefined;
	const symbol: IndexedSymbol = {
		name: declaration.name,
		kind: declaration.kind,
		uri,
		range: declaration.range,
		containerName,
	};
	if (declaration.kind === "function") {
		symbol.returnType = declaration.returnType;
		symbol.static = declaration.static;
		symbol.parameters = declaration.parameters.map((parameter) => ({
			name: parameter.name,
			type: parameter.type,
			defaultValue: parameter.defaultValue,
		}));
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
	const visit = (declarations: GDScriptDeclaration[], containerName?: string) => {
		for (const declaration of declarations) {
			if (declaration.kind === "enum") {
				// Named enums are types whose members are only reachable through the
				// enum name; members of unnamed enums act as plain script constants.
				const symbol = declarationToSymbol(declaration, uri, containerName, source, sourceLines);
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
						containerName: declaration.name ?? containerName,
						type: declaration.name,
						...(documentation ? { documentation } : {}),
					});
				}
				continue;
			}
			const symbol = declarationToSymbol(declaration, uri, containerName, source, sourceLines);
			if (symbol) symbols.push(symbol);
			if (declaration.kind === "class") visit(declaration.declarations, declaration.name);
		}
	};
	visit(ast.declarations);
	return symbols;
}
