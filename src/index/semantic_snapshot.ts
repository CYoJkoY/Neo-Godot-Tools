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
		documentation: symbol.documentation,
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
	// Two independent 32-bit FNV-style lanes avoid allocating a BigInt for every
	// UTF-16 code unit. Fingerprints are a cache hint, not a security boundary.
	let first = 0x811c9dc5;
	let second = 0x9e3779b9;
	for (let index = 0; index < source.length; index++) {
		const code = source.charCodeAt(index);
		first = Math.imul(first ^ code, 0x01000193);
		second = Math.imul(second ^ code, 0x85ebca6b);
	}
	return `${(first >>> 0).toString(16).padStart(8, "0")}${(second >>> 0).toString(16).padStart(8, "0")}`;
}
