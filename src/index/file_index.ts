import { GDScriptParseResult, parseGDScript } from "../analyzer/index.js";
import { collectSymbols, IndexedFile } from "./symbol.js";
import { createApiFingerprint } from "./semantic_snapshot.js";
import { languageProfiler } from "../performance/profiler.js";

export class FileIndex {
	private readonly files = new Map<string, IndexedFile>();

	update(uri: string, source: string, version = 0, parsed?: GDScriptParseResult): IndexedFile {
		const result = languageProfiler.measure("parse", () => parsed ?? parseGDScript(source));
		const symbols = languageProfiler.measure("collectSymbols", () => collectSymbols(result.ast, uri));
		const file: IndexedFile = {
			uri,
			version,
			source,
			ast: result.ast,
			diagnostics: result.diagnostics,
			symbols,
			apiFingerprint: createApiFingerprint(result.ast, source, symbols),
		};
		this.files.set(uri, file);
		return file;
	}

	remove(uri: string): boolean {
		return this.files.delete(uri);
	}

	get(uri: string): IndexedFile | undefined {
		return this.files.get(uri);
	}

	get size(): number {
		return this.files.size;
	}

	values(): IterableIterator<IndexedFile> {
		return this.files.values();
	}

	clear(): void {
		this.files.clear();
	}
}
