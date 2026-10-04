import { GDScriptParseResult, parseGDScript } from "../analyzer/index.js";
import { languageProfiler } from "../performance/profiler.js";
import { createApiFingerprint, createSourceFingerprint } from "./semantic_snapshot.js";
import { IndexedFile, collectSymbols } from "./symbol.js";

/** Normalizes a uri into the `res://`-style path used by script references. */
export function normalizedFilePath(uri: string): string {
	try {
		return decodeURIComponent(new URL(uri).pathname).replace(/^\/+/, "");
	} catch {
		return uri.replace(/^\/+/, "");
	}
}

function baseName(path: string): string {
	const index = path.lastIndexOf("/");
	return index >= 0 ? path.slice(index + 1) : path;
}

export interface FileIndex {
	readonly size: number;
	/** Parses and stores `source`; an unchanged source keeps the previous object. */
	update(uri: string, source: string, version?: number, parsed?: GDScriptParseResult): IndexedFile;
	remove(uri: string): boolean;
	get(uri: string): IndexedFile | undefined;
	/** Resolves a script reference to one indexed file, or `undefined` when ambiguous. */
	findByPathSuffix(reference: string): string | undefined;
	values(): IterableIterator<IndexedFile>;
	clear(): void;
}

export function createFileIndex(): FileIndex {
	const files = new Map<string, IndexedFile>();
	/**
	 * Basename -> uris. Script references (`res://scripts/player.gd`,
	 * `"player.gd"`, `extends "res://..."`) resolve to full path suffixes; the
	 * basename bucket keeps that lookup from scanning every indexed file, which
	 * made project-wide indexing quadratic.
	 */
	const byBaseName = new Map<string, Set<string>>();

	const rememberPath = (uri: string): void => {
		const name = baseName(normalizedFilePath(uri));
		const entries = byBaseName.get(name) ?? new Set<string>();
		entries.add(uri);
		byBaseName.set(name, entries);
	};

	const forgetPath = (uri: string): void => {
		const name = baseName(normalizedFilePath(uri));
		const entries = byBaseName.get(name);
		if (!entries) return;
		entries.delete(uri);
		if (!entries.size) byBaseName.delete(name);
	};

	return {
		get size(): number {
			return files.size;
		},

		update(uri: string, source: string, version = 0, parsed?: GDScriptParseResult): IndexedFile {
			const previous = files.get(uri);
			if (previous?.source === source && !parsed) {
				if (previous.version === version) return previous;
				// The semantic snapshot is unchanged: keep the same object identity and
				// only advance the document version so callers can reuse cached results.
				previous.version = version;
				return previous;
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
			if (!previous) rememberPath(uri);
			files.set(uri, file);
			return file;
		},

		remove(uri: string): boolean {
			if (!files.delete(uri)) return false;
			forgetPath(uri);
			return true;
		},

		get: (uri) => files.get(uri),

		/**
		 * Resolves a script reference to a single indexed file, or `undefined` when
		 * the reference is ambiguous or unknown. Matching is a path-suffix match so
		 * `res://scripts/player.gd` finds `/workspace/scripts/player.gd`.
		 */
		findByPathSuffix(reference: string): string | undefined {
			// Strip the scheme before URL parsing: `new URL("res://a/b.gd").pathname`
			// drops the first segment, because `a` is parsed as the host.
			const raw = reference.replace(/^[A-Za-z][A-Za-z0-9+.-]*:\/\//, "");
			let decoded = raw;
			try {
				decoded = decodeURIComponent(raw);
			} catch {
				/* keep the raw text when it is not valid percent-encoding */
			}
			const path = decoded.replace(/\\/g, "/").replace(/^\/+/, "").replace(/\/+/g, "/");
			if (!path) return undefined;
			const candidates = byBaseName.get(baseName(path));
			if (!candidates?.size) return undefined;
			const normalized = path.replace(/^\/+/, "");
			const matches = [...candidates].filter((uri) => normalizedFilePath(uri).endsWith(normalized));
			return matches.length === 1 ? matches[0] : undefined;
		},

		values: () => files.values(),

		clear(): void {
			files.clear();
			byBaseName.clear();
		},
	};
}
