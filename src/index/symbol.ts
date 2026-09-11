import { GDScriptDeclaration, GDScriptDiagnostic, GDScriptFunction, GDScriptScript, SourceRange } from "../analyzer/index.js";

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

export function declarationToSymbol(declaration: GDScriptDeclaration, uri: string, containerName?: string): IndexedSymbol | undefined {
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
	return symbol;
}

export function collectSymbols(ast: GDScriptScript, uri: string): IndexedSymbol[] {
	const symbols: IndexedSymbol[] = [];
	const visit = (declarations: GDScriptDeclaration[], containerName?: string) => {
		for (const declaration of declarations) {
			const symbol = declarationToSymbol(declaration, uri, containerName);
			if (symbol) symbols.push(symbol);
			if (declaration.kind === "class") visit(declaration.declarations, declaration.name);
		}
	};
	visit(ast.declarations);
	return symbols;
}
