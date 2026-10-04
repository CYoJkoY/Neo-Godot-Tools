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
		documentation: symbol.documentation,
	});
}

function collectionSignature(symbols: readonly IndexedSymbol[]): string {
	return symbols.map(symbolSignature).sort().join("|");
}

export interface SymbolIndex {
	/** Re-reads the symbols of one indexed file. */
	update(uri: string): void;
	remove(uri: string): void;
	find(name: string): readonly IndexedSymbol[];
	/** Stable identity of everything indexed under `name`, for cache validation. */
	signature(name: string): string;
	findInFile(uri: string, name: string): IndexedSymbol | undefined;
	workspaceSymbols(query?: string): IndexedSymbol[];
	workspaceSignature(query?: string): string;
	clear(): void;
}

export function createSymbolIndex(files: FileIndex): SymbolIndex {
	const byName = new Map<string, IndexedSymbol[]>();
	const byUri = new Map<string, IndexedSymbol[]>();

	const addByName = (symbol: IndexedSymbol): void => {
		const entries = byName.get(symbol.name) ?? [];
		entries.push(symbol);
		byName.set(symbol.name, entries);
	};

	const dropByName = (symbol: IndexedSymbol, uri: string): void => {
		const entries = byName.get(symbol.name);
		if (!entries) return;
		const remaining = entries.filter((entry) => entry.uri !== uri);
		if (remaining.length) byName.set(symbol.name, remaining);
		else byName.delete(symbol.name);
	};

	const find = (name: string): readonly IndexedSymbol[] => byName.get(name) ?? [];

	const remove = (uri: string): void => {
		const symbols = byUri.get(uri);
		if (!symbols) return;
		byUri.delete(uri);
		symbols.map((symbol) => dropByName(symbol, uri));
	};

	const update = (uri: string): void => {
		remove(uri);
		const file = files.get(uri);
		if (!file) return;
		const symbols = [...file.symbols];
		byUri.set(uri, symbols);
		symbols.map(addByName);
	};

	const workspaceSymbols = (query = ""): IndexedSymbol[] => {
		const normalized = query.toLowerCase();
		const result = [...byUri.values()]
			.flat()
			.filter((symbol) => !normalized || symbol.name.toLowerCase().includes(normalized));
		// The file map has no meaningful order; sort so completions and signatures
		// stay stable no matter when each file was indexed.
		return result.sort(
			(left, right) =>
				left.name.localeCompare(right.name) ||
				left.uri.localeCompare(right.uri) ||
				left.range.start.offset - right.range.start.offset,
		);
	};

	return {
		update,
		remove,
		find,
		signature: (name) => collectionSignature(find(name)),
		findInFile: (uri, name) => byUri.get(uri)?.find((symbol) => symbol.name === name),
		workspaceSymbols,
		workspaceSignature: (query = "") => collectionSignature(workspaceSymbols(query)),
		clear: () => {
			byName.clear();
			byUri.clear();
		},
	};
}
