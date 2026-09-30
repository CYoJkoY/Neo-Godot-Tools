import { GDScriptParseResult, parseGDScript } from "../analyzer/index.js";
import { collectSymbols, IndexedFile } from "./symbol.js";
import { createApiFingerprint, createSourceFingerprint } from "./semantic_snapshot.js";
import { languageProfiler } from "../performance/profiler.js";

export class FileIndex {
	private readonly files = new Map<string, IndexedFile>();

	update(uri: string, source: string, version = 0, parsed?: GDScriptParseResult): IndexedFile {
		const previous = this.files.get(uri);
		if (previous?.source === source && !parsed) {
			if (previous.version === version) return previous;
			// The semantic snapshot is unchanged: keep the same object identity and
			// only advance the document version so callers can reuse cached results.
			const file = previous;
			file.version = version;
			return file;
		}
		const result = languageProfiler.measure("parse", () => parsed ?? parseGDScript(source));
		const symbols = languageProfiler.measure("collectSymbols", () => collectSymbols(result.ast, uri, source));
		const file: IndexedFile = {
			uri,
			version,
			source,
			sourceFingerprint: createSourceFingerprint(source),
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
