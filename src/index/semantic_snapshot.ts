import type { GDScriptDeclaration, GDScriptScript } from "../analyzer/index.js";
import type { IndexedSymbol } from "./symbol.js";

export interface SemanticSnapshot {
	apiFingerprint: string;
}

function collectExtends(declarations: GDScriptDeclaration[]): string[] {
	return declarations.flatMap((declaration) => {
		if (declaration.kind === "extends") return [declaration.name];
		if (declaration.kind === "class") return collectExtends(declaration.declarations);
		return [];
	});
}

function symbolSignature(symbol: IndexedSymbol): unknown {
	return {
		name: symbol.name,
		kind: symbol.kind,
		containerName: symbol.containerName,
		type: symbol.type,
		returnType: symbol.returnType,
		static: symbol.static,
		parameters: symbol.parameters?.map((parameter) => ({
			name: parameter.name,
			type: parameter.type,
			defaultValue: parameter.defaultValue,
		})),
	};
}

export function createApiFingerprint(ast: GDScriptScript, _source: string, symbols: readonly IndexedSymbol[]): string {
	return JSON.stringify({
		extends: collectExtends(ast.declarations),
		symbols: symbols.map(symbolSignature),
	});
}

export function createSourceFingerprint(source: string): string {
	let hash = 14695981039346656037n;
	const prime = 1099511628211n;
	const mask = 0xffffffffffffffffn;
	for (let index = 0; index < source.length; index++) {
		hash ^= BigInt(source.charCodeAt(index));
		hash = (hash * prime) & mask;
	}
	return hash.toString(16).padStart(16, "0");
}
