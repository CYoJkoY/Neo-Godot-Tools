import { GDScriptDeclaration } from "../analyzer/index.js";
import { FileIndex, normalizedFilePath } from "./file_index.js";

export interface DependencyEdge {
	from: string;
	to: string;
	reason: "extends" | "preload";
}

function normalizePath(value: string): string {
	return value
		.replace(/^res:\/\//, "")
		.replace(/\\/g, "/")
		.replace(/^\/+/, "");
}

function collectPreloads(source: string): string[] {
	const result: string[] = [];
	const pattern = /preload\s*\(\s*["']([^"']+)["']\s*\)/g;
	for (const match of source.matchAll(pattern)) result.push(match[1]);
	return result;
}

function collectExtends(declarations: GDScriptDeclaration[]): string[] {
	return declarations.flatMap((declaration) => {
		if (declaration.kind === "extends") return [declaration.name];
		if (declaration.kind === "class") return collectExtends(declaration.declarations);
		return [];
	});
}

function candidateKeys(value: string): string[] {
	const path = normalizePath(value);
	const name = path.split("/").pop();
	return name && name !== path ? [path, name] : [path];
}

function collectClassNames(declarations: GDScriptDeclaration[]): string[] {
	return declarations.flatMap((declaration) => {
		if (declaration.kind === "class_name") return [declaration.name];
		if (declaration.kind === "class") return collectClassNames(declaration.declarations);
		return [];
	});
}

function baseName(path: string): string {
	const index = path.lastIndexOf("/");
	return index >= 0 ? path.slice(index + 1) : path;
}

export interface DependencyGraph {
	update(uri: string): string[];
	getDependencies(uri: string): readonly DependencyEdge[];
	getDependents(uri: string): readonly string[];
	getTransitiveDependents(uri: string): string[];
	remove(uri: string): string[];
	clear(): void;
}

export function createDependencyGraph(files: FileIndex): DependencyGraph {
	const outgoing = new Map<string, DependencyEdge[]>();

	const incoming = new Map<string, Set<string>>();

	const unresolved = new Map<string, Set<string>>();

	const classNames = new Map<string, string[]>();
	/** uri -> unresolved keys it registered, so removal never scans every key. */
	const unresolvedByUri = new Map<string, Set<string>>();
	/** class_name -> declaring uris, kept incrementally instead of rescanned. */
	const classNamesByUri = new Map<string, string[]>();

	const classNameToUris = new Map<string, Set<string>>();
	/** basename -> uris, so `res://` lookups never scan the whole file index. */
	const pathToUris = new Map<string, Set<string>>();
	/** Guards the recursive refresh chain against cycles between files. */
	const refreshing = new Set<string>();

	const pathsByUri = new Map<string, string>();

	const indexedUris = new Set<string>();

	const update = (uri: string): string[] => {
		ensureClassIndex();
		const previousClassNames = [...(classNames.get(uri) ?? [])];
		removeOutgoing(uri);
		rememberClassNames(uri);
		rememberPath(uri);
		const file = files.get(uri);
		if (!file) return refreshForTarget(uri, previousClassNames);
		const targets = new Map<string, DependencyEdge>();
		for (const value of collectExtends(file.ast.declarations)) addCandidate(uri, value, "extends", targets);
		for (const value of collectPreloads(file.source)) addCandidate(uri, value, "preload", targets);
		const edges = [...targets.values()];
		outgoing.set(uri, edges);
		for (const edge of edges) {
			const dependents = incoming.get(edge.to) ?? new Set<string>();
			dependents.add(uri);
			incoming.set(edge.to, dependents);
		}
		return refreshForTarget(uri, previousClassNames);
	};

	const getDependencies = (uri: string): readonly DependencyEdge[] => {
		return outgoing.get(uri) ?? [];
	};

	const getDependents = (uri: string): readonly string[] => {
		return [...(incoming.get(uri) ?? [])];
	};

	const getTransitiveDependents = (uri: string): string[] => {
		const result: string[] = [];
		const visited = new Set<string>([uri]);
		// A live array cursor instead of `shift()`: shifting is O(n) per element, so
		// a chain of dependents used to cost quadratic time.
		const pending = [...(incoming.get(uri) ?? [])];
		// perf: breadth-first walk of the dependents graph, on the semantic
		// invalidation path measured by `tools/semantic_scale_benchmark.ts`
		// (single edit p50 1.34 ms over 5 000 indexed files).
		for (const current of pending) {
			if (visited.has(current)) continue;
			visited.add(current);
			result.push(current);
			pending.push(...(incoming.get(current) ?? []));
		}
		return result;
	};

	const remove = (uri: string): string[] => {
		ensureClassIndex();
		const dependents = [...getDependents(uri)];
		const keys = targetKeys(uri);
		for (const dependent of dependents) {
			const edges = outgoing.get(dependent) ?? [];
			const remaining = edges.filter((edge) => edge.to !== uri);
			if (remaining.length !== edges.length) {
				outgoing.set(dependent, remaining);
				for (const key of keys) {
					const candidates = unresolved.get(key) ?? new Set<string>();
					candidates.add(dependent);
					unresolved.set(key, candidates);
					const registered = unresolvedByUri.get(dependent) ?? new Set<string>();
					registered.add(key);
					unresolvedByUri.set(dependent, registered);
				}
			}
		}
		removeOutgoing(uri);
		incoming.delete(uri);
		for (const entries of incoming.values()) entries.delete(uri);
		classNames.delete(uri);
		forgetClassNames(uri);
		forgetPath(uri);
		indexedUris.delete(uri);
		return dependents;
	};

	const clear = (): void => {
		outgoing.clear();
		incoming.clear();
		unresolved.clear();
		classNames.clear();
		unresolvedByUri.clear();
		classNamesByUri.clear();
		classNameToUris.clear();
		pathToUris.clear();
		pathsByUri.clear();
		indexedUris.clear();
		refreshing.clear();
	};

	/**
	 * Builds the class-name/path lookups from the current file index once. Files
	 * indexed before their first `update` (or never updated) must still be found,
	 * otherwise `extends Base` would only resolve if the base file happened to be
	 * updated first.
	 */
	const ensureClassIndex = (): void => {
		if (indexedUris.size === files.size) return;
		for (const file of files.values()) {
			if (indexedUris.has(file.uri)) continue;
			indexedUris.add(file.uri);
			if (!pathsByUri.has(file.uri)) rememberPath(file.uri);
			if (!classNamesByUri.has(file.uri)) rememberClassNames(file.uri);
		}
	};

	const refreshForTarget = (uri: string, extraKeys: readonly string[] = []): string[] => {
		const candidates = new Set<string>();
		for (const key of [...targetKeys(uri), ...extraKeys]) {
			for (const candidate of unresolved.get(key) ?? []) {
				if (candidate !== uri) candidates.add(candidate);
			}
		}
		if (!candidates.size) return [];
		refreshing.add(uri);
		try {
			for (const candidate of candidates) {
				if (refreshing.has(candidate)) continue;
				update(candidate);
			}
		} finally {
			refreshing.delete(uri);
		}
		return [...candidates];
	};

	/** Records the class names the graph last saw for a file (used for refresh bookkeeping). */
	const rememberClassNames = (uri: string): void => {
		forgetClassNames(uri);
		const names = classNamesOf(uri);
		if (!names.length) {
			classNames.delete(uri);
			return;
		}
		classNames.set(uri, names);
		classNamesByUri.set(uri, names);
		for (const name of names) {
			const entries = classNameToUris.get(name) ?? new Set<string>();
			entries.add(uri);
			classNameToUris.set(name, entries);
		}
	};

	const forgetClassNames = (uri: string): void => {
		const names = classNamesByUri.get(uri);
		if (!names) return;
		classNamesByUri.delete(uri);
		for (const name of names) {
			const entries = classNameToUris.get(name);
			if (!entries) continue;
			entries.delete(uri);
			if (!entries.size) classNameToUris.delete(name);
		}
	};

	const rememberPath = (uri: string): void => {
		const previous = pathsByUri.get(uri);
		if (previous !== undefined) return;
		const path = normalizePath(normalizedFilePath(uri));
		pathsByUri.set(uri, path);
		const key = baseName(path);
		const entries = pathToUris.get(key) ?? new Set<string>();
		entries.add(uri);
		pathToUris.set(key, entries);
	};

	const forgetPath = (uri: string): void => {
		const path = pathsByUri.get(uri);
		if (path === undefined) return;
		pathsByUri.delete(uri);
		const key = baseName(path);
		const entries = pathToUris.get(key);
		if (!entries) return;
		entries.delete(uri);
		if (!entries.size) pathToUris.delete(key);
	};

	const classNamesOf = (uri: string): string[] => {
		const file = files.get(uri);
		return file ? collectClassNames(file.ast.declarations) : [];
	};

	/** Resolves a project `class_name` against the current file index. */
	const resolveClassName = (value: string): string | undefined => {
		const matches = classNameToUris.get(value);
		if (!matches || matches.size !== 1) return undefined;
		return matches.values().next().value;
	};

	const addCandidate = (
		uri: string,
		value: string,
		reason: DependencyEdge["reason"],
		targets: Map<string, DependencyEdge>,
	): void => {
		const target = resolveTarget(value);
		if (target && target !== uri) {
			targets.set(target, { from: uri, to: target, reason });
			return;
		}
		const registered = unresolvedByUri.get(uri) ?? new Set<string>();
		for (const key of candidateKeys(value)) {
			const candidates = unresolved.get(key) ?? new Set<string>();
			candidates.add(uri);
			unresolved.set(key, candidates);
			registered.add(key);
		}
		unresolvedByUri.set(uri, registered);
	};

	const removeOutgoing = (uri: string): void => {
		const registered = unresolvedByUri.get(uri);
		if (registered) {
			unresolvedByUri.delete(uri);
			for (const key of registered) {
				const candidates = unresolved.get(key);
				if (!candidates) continue;
				candidates.delete(uri);
				if (!candidates.size) unresolved.delete(key);
			}
		}
		for (const edge of outgoing.get(uri) ?? []) {
			const dependents = incoming.get(edge.to);
			dependents?.delete(uri);
			if (dependents?.size === 0) incoming.delete(edge.to);
		}
		outgoing.delete(uri);
	};

	const resolveTarget = (value: string): string | undefined => {
		const path = normalizePath(value);
		const byPath = files.findByPathSuffix(path);
		if (value.startsWith("res://") || value.endsWith(".gd") || path.includes("/")) {
			if (byPath) return byPath;
		}
		const named = resolveClassName(value.split(".")[0]);
		if (named) return named;
		const name = value.split("/").pop()?.replace(/\.gd$/, "");
		if (!name) return undefined;
		const matches = pathToUris.get(`${name}.gd`);
		if (matches?.size === 1) return matches.values().next().value;
		return undefined;
	};

	const targetKeys = (uri: string): string[] => {
		const path = pathsByUri.get(uri) ?? normalizePath(normalizedFilePath(uri));
		const name = path.split("/").pop();
		return [...(name && name !== path ? [path, name] : [path]), ...(classNames.get(uri) ?? classNamesOf(uri))];
	};

	return {
		update,
		getDependencies,
		getDependents,
		getTransitiveDependents,
		remove,
		clear,
	};
}
