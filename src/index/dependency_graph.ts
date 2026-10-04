import { GDScriptDeclaration } from "../analyzer/index.js";
import { addToSet, dropFromSet } from "./collections.js";
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
	const pattern = /preload\s*\(\s*["']([^"']+)["']\s*\)/g;
	return [...source.matchAll(pattern)].map((match) => match[1]);
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
		collectExtends(file.ast.declarations).map((value) => addCandidate(uri, value, "extends", targets));
		collectPreloads(file.source).map((value) => addCandidate(uri, value, "preload", targets));
		const edges = [...targets.values()];
		outgoing.set(uri, edges);
		edges.map((edge) => addToSet(incoming, edge.to, uri));
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
		dependents.map((dependent) => {
			const edges = outgoing.get(dependent) ?? [];
			const remaining = edges.filter((edge) => edge.to !== uri);
			if (remaining.length === edges.length) return;
			outgoing.set(dependent, remaining);
			keys.map((key) => {
				addToSet(unresolved, key, dependent);
				addToSet(unresolvedByUri, dependent, key);
			});
		});
		removeOutgoing(uri);
		incoming.delete(uri);
		[...incoming.values()].map((entries) => entries.delete(uri));
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
		[...files.values()]
			.filter((file) => !indexedUris.has(file.uri))
			.map((file) => {
				indexedUris.add(file.uri);
				if (!pathsByUri.has(file.uri)) rememberPath(file.uri);
				if (!classNamesByUri.has(file.uri)) rememberClassNames(file.uri);
			});
	};

	const refreshForTarget = (uri: string, extraKeys: readonly string[] = []): string[] => {
		const candidates = new Set(
			[...targetKeys(uri), ...extraKeys].flatMap((key) => [...(unresolved.get(key) ?? [])]),
		);
		candidates.delete(uri);
		if (!candidates.size) return [];
		refreshing.add(uri);
		try {
			[...candidates].filter((candidate) => !refreshing.has(candidate)).map(update);
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
		names.map((name) => addToSet(classNameToUris, name, uri));
	};

	const forgetClassNames = (uri: string): void => {
		const names = classNamesByUri.get(uri);
		if (!names) return;
		classNamesByUri.delete(uri);
		names.map((name) => dropFromSet(classNameToUris, name, uri));
	};

	const rememberPath = (uri: string): void => {
		const previous = pathsByUri.get(uri);
		if (previous !== undefined) return;
		const path = normalizePath(normalizedFilePath(uri));
		pathsByUri.set(uri, path);
		addToSet(pathToUris, baseName(path), uri);
	};

	const forgetPath = (uri: string): void => {
		const path = pathsByUri.get(uri);
		if (path === undefined) return;
		pathsByUri.delete(uri);
		dropFromSet(pathToUris, baseName(path), uri);
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
		candidateKeys(value).map((key) => {
			addToSet(unresolved, key, uri);
			registered.add(key);
		});
		unresolvedByUri.set(uri, registered);
	};

	const removeOutgoing = (uri: string): void => {
		const registered = unresolvedByUri.get(uri);
		if (registered) {
			unresolvedByUri.delete(uri);
			[...registered].map((key) => dropFromSet(unresolved, key, uri));
		}
		(outgoing.get(uri) ?? []).map((edge) => {
			const dependents = incoming.get(edge.to);
			dependents?.delete(uri);
			if (dependents?.size === 0) incoming.delete(edge.to);
		});
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
