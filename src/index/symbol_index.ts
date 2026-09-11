import { FileIndex } from "./file_index.js";
import { IndexedSymbol } from "./symbol.js";

function symbolSignature(symbol: IndexedSymbol): string {
	return JSON.stringify({
		name: symbol.name,
		kind: symbol.kind,
		uri: symbol.uri,
		start: symbol.range.start.offset,
		end: symbol.range.end.offset,
		containerName: symbol.containerName,
		returnType: symbol.returnType,
		type: symbol.type,
		parameters: symbol.parameters,
		static: symbol.static,
	});
}

function collectionSignature(symbols: readonly IndexedSymbol[]): string {
	return symbols.map(symbolSignature).sort().join("|");
}

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

	signature(name: string): string {
	return collectionSignature(this.find(name));
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

	workspaceSignature(query = ""): string {
		return collectionSignature(this.workspaceSymbols(query));
	}

	clear(): void {
		this.byName.clear();
		this.byUri.clear();
	}
}
