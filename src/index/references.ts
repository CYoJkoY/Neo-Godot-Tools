import { lexGDScript, GDScriptToken } from "../analyzer/index.js";
import { FileIndex } from "./file_index";
import { IndexedSymbol } from "./symbol";

export interface IndexedReference {
	name: string;
	uri: string;
	range: {
		start: { offset: number; line: number; character: number };
		end: { offset: number; line: number; character: number };
	};
}

const keywords = new Set([
	"and", "as", "await", "breakpoint", "break", "class_name", "class", "const", "continue",
	"elif", "else", "enum", "extends", "false", "for", "func", "if", "in", "is", "match",
	"not", "null", "or", "pass", "preload", "return", "self", "signal", "static", "super",
	"true", "var", "while", "when", "void",
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
	return reference.uri === symbol.uri
		&& reference.range.start.offset === symbol.range.start.offset
		&& reference.range.end.offset === symbol.range.end.offset;
}

export function collectReferences(source: string, uri: string): IndexedReference[] {
	return lexGDScript(source)
		.filter((token) => token.kind === "identifier" && !keywords.has(token.value))
		.map((token) => toReference(token, uri));
}

export class ReferenceIndex {
	private readonly byName = new Map<string, IndexedReference[]>();
	private readonly byUri = new Map<string, IndexedReference[]>();

	constructor(private readonly files: FileIndex) {}

	update(uri: string): void {
		this.remove(uri);
		const file = this.files.get(uri);
		if (!file) return;
		const references = collectReferences(file.source, uri);
		this.byUri.set(uri, references);
		for (const reference of references) {
			const key = reference.name.toLowerCase();
			const entries = this.byName.get(key) ?? [];
			entries.push(reference);
			this.byName.set(key, entries);
		}
	}

	find(name: string): IndexedReference[] {
		return [...(this.byName.get(name.toLowerCase()) ?? [])];
	}

	findForSymbol(symbol: IndexedSymbol, includeDeclaration: boolean): IndexedReference[] {
		return this.find(symbol.name).filter((reference) => includeDeclaration || !isDeclaration(reference, symbol));
	}

	remove(uri: string): void {
		const references = this.byUri.get(uri);
		if (!references) return;
		for (const reference of references) {
			const key = reference.name.toLowerCase();
			const entries = this.byName.get(key);
			if (!entries) continue;
			const remaining = entries.filter((entry) => entry.uri !== uri || entry.range.start.offset !== reference.range.start.offset);
			if (remaining.length) this.byName.set(key, remaining);
			else this.byName.delete(key);
		}
		this.byUri.delete(uri);
	}

	clear(): void {
		this.byName.clear();
		this.byUri.clear();
	}
}
