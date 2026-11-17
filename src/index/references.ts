import { GDScriptToken, lexGDScript } from "../analyzer/index.js";
import { dropFromGroup } from "./collections.js";
import { FileIndex } from "./file_index.js";
import { IndexedSymbol } from "./symbol.js";
import { tokensFor } from "./token_cache.js";

export interface IndexedReference {
	name: string;
	uri: string;
	range: {
		start: { offset: number; line: number; character: number };
		end: { offset: number; line: number; character: number };
	};
}

const keywords = new Set([
	"and",
	"as",
	"await",
	"breakpoint",
	"break",
	"class_name",
	"class",
	"const",
	"continue",
	"elif",
	"else",
	"enum",
	"extends",
	"false",
	"for",
	"func",
	"if",
	"in",
	"is",
	"match",
	"not",
	"null",
	"or",
	"pass",
	"preload",
	"return",
	"self",
	"signal",
	"static",
	"super",
	"true",
	"var",
	"while",
	"when",
	"void",
]);

function toReference(token: GDScriptToken, uri: string): IndexedReference {
	return {
		name: token.value,
		uri,
		range: {
			start: { offset: token.start, line: token.line, character: token.character },
			end: { offset: token.end, line: token.line, character: token.character + (token.end - token.start) },
		},
	};
}

function isDeclaration(reference: IndexedReference, symbol: IndexedSymbol): boolean {
	return (
		reference.uri === symbol.uri &&
		reference.range.start.offset === symbol.range.start.offset &&
		reference.range.end.offset === symbol.range.end.offset
	);
}

function referencesFromTokens(tokens: readonly GDScriptToken[], uri: string): IndexedReference[] {
	return tokens
		.filter((token) => token.kind === "identifier" && !keywords.has(token.value))
		.map((token) => toReference(token, uri));
}

export function collectReferences(source: string, uri: string): IndexedReference[] {
	return referencesFromTokens(lexGDScript(source), uri);
}

export interface ReferenceIndex {
	update(uri: string): void;
	find(name: string): IndexedReference[];
	findForSymbol(symbol: IndexedSymbol, includeDeclaration: boolean): IndexedReference[];
	remove(uri: string): void;
	clear(): void;
}

export function createReferenceIndex(files: FileIndex): ReferenceIndex {
	const byName = new Map<string, IndexedReference[]>();

	const byUri = new Map<string, IndexedReference[]>();

	const update = (uri: string): void => {
		remove(uri);
		const file = files.get(uri);
		if (!file) return;
		// The binding and type layers already lexed this exact text, so the
		// reference pass reads the shared token stream instead of lexing again.
		const references = referencesFromTokens(tokensFor(uri, file.source, file.sourceFingerprint), uri);
		byUri.set(uri, references);
		for (const reference of references) {
			const key = reference.name.toLowerCase();
			const entries = byName.get(key) ?? [];
			entries.push(reference);
			byName.set(key, entries);
		}
	};

	const find = (name: string): IndexedReference[] => {
		return [...(byName.get(name.toLowerCase()) ?? [])];
	};

	const findForSymbol = (symbol: IndexedSymbol, includeDeclaration: boolean): IndexedReference[] => {
		return find(symbol.name).filter((reference) => includeDeclaration || !isDeclaration(reference, symbol));
	};

	const remove = (uri: string): void => {
		const references = byUri.get(uri);
		if (!references) return;
		// One filter per distinct name: filtering the bucket once per reference
		// made removing a file quadratic in its repeated identifiers (`alpha`
		// appearing 8 000 times filtered an 8 000-entry bucket 8 000 times).
		for (const key of new Set(references.map((reference) => reference.name.toLowerCase()))) {
			dropFromGroup(byName, key, (entry) => entry.uri === uri);
		}
		byUri.delete(uri);
	};

	const clear = (): void => {
		byName.clear();
		byUri.clear();
	};

	return {
		update,
		find,
		findForSymbol,
		remove,
		clear,
	};
}
