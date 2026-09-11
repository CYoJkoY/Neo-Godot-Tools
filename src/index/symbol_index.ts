import { FileIndex } from "./file_index.js";
import { IndexedSymbol } from "./symbol.js";

export class SymbolIndex {
	private readonly byName = new Map<string, IndexedSymbol[]>();
	private readonly byUri = new Map<string, IndexedSymbol[]>();

	constructor(private readonly files: FileIndex) {}

	update(uri: string): void {
		this.remove(uri);
		const file = this.files.get(uri);
		if (!file) return;
		const symbols = [...file.symbols];
		this.byUri.set(uri, symbols);
		for (const symbol of symbols) {
			const entries = this.byName.get(symbol.name) ?? [];
			entries.push(symbol);
			this.byName.set(symbol.name, entries);
		}
	}

	remove(uri: string): void {
		const symbols = this.byUri.get(uri);
		if (!symbols) return;
		this.byUri.delete(uri);
		for (const symbol of symbols) {
			const entries = this.byName.get(symbol.name);
			if (!entries) continue;
			const remaining = entries.filter((entry) => entry.uri !== uri);
			if (remaining.length) this.byName.set(symbol.name, remaining);
			else this.byName.delete(symbol.name);
		}
	}

	find(name: string): readonly IndexedSymbol[] {
		return this.byName.get(name) ?? [];
	}

	findInFile(uri: string, name: string): IndexedSymbol | undefined {
		return this.byUri.get(uri)?.find((symbol) => symbol.name === name);
	}

	workspaceSymbols(query = ""): IndexedSymbol[] {
		const normalized = query.toLowerCase();
		const result: IndexedSymbol[] = [];
		for (const symbols of this.byUri.values()) {
			for (const symbol of symbols) {
				if (!normalized || symbol.name.toLowerCase().includes(normalized)) result.push(symbol);
			}
		}
		return result;
	}

	clear(): void {
		this.byName.clear();
		this.byUri.clear();
	}
}
