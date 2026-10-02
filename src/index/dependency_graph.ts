import { GDScriptDeclaration } from "../analyzer/index.js";
import { FileIndex, normalizedFilePath } from "./file_index.js";

export interface DependencyEdge {
	from: string;
	to: string;
	reason: "extends" | "preload";
}

function normalizePath(value: string): string {
	return value.replace(/^res:\/\//, "").replace(/\\/g, "/").replace(/^\/+/, "");
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

export class DependencyGraph {
	private readonly outgoing = new Map<string, DependencyEdge[]>();
	private readonly incoming = new Map<string, Set<string>>();
	private readonly unresolved = new Map<string, Set<string>>();
	private readonly classNames = new Map<string, string[]>();
	/** uri -> unresolved keys it registered, so removal never scans every key. */
	private readonly unresolvedByUri = new Map<string, Set<string>>();
	/** class_name -> declaring uris, kept incrementally instead of rescanned. */
	private readonly classNamesByUri = new Map<string, string[]>();
	private readonly classNameToUris = new Map<string, Set<string>>();
	/** basename -> uris, so `res://` lookups never scan the whole file index. */
	private readonly pathToUris = new Map<string, Set<string>>();
	/** Guards the recursive refresh chain against cycles between files. */
	private readonly refreshing = new Set<string>();
	private readonly pathsByUri = new Map<string, string>();
	private readonly indexedUris = new Set<string>();

	constructor(private readonly files: FileIndex) {}

	update(uri: string): string[] {
		this.ensureClassIndex();
		const previousClassNames = [...(this.classNames.get(uri) ?? [])];
		this.removeOutgoing(uri);
		this.rememberClassNames(uri);
		this.rememberPath(uri);
		const file = this.files.get(uri);
		if (!file) return this.refreshForTarget(uri, previousClassNames);
		const targets = new Map<string, DependencyEdge>();
		for (const value of collectExtends(file.ast.declarations)) this.addCandidate(uri, value, "extends", targets);
		for (const value of collectPreloads(file.source)) this.addCandidate(uri, value, "preload", targets);
		const edges = [...targets.values()];
		this.outgoing.set(uri, edges);
		for (const edge of edges) {
			const dependents = this.incoming.get(edge.to) ?? new Set<string>();
			dependents.add(uri);
			this.incoming.set(edge.to, dependents);
		}
		return this.refreshForTarget(uri, previousClassNames);
	}

	getDependencies(uri: string): readonly DependencyEdge[] { return this.outgoing.get(uri) ?? []; }
	getDependents(uri: string): readonly string[] { return [...(this.incoming.get(uri) ?? [])]; }

	getTransitiveDependents(uri: string): string[] {
		const result: string[] = [];
		const visited = new Set<string>([uri]);
		const queue = [...(this.incoming.get(uri) ?? [])];
		while (queue.length) {
			const current = queue.shift()!;
			if (visited.has(current)) continue;
			visited.add(current);
			result.push(current);
			queue.push(...(this.incoming.get(current) ?? []));
		}
		return result;
	}

	remove(uri: string): string[] {
		this.ensureClassIndex();
		const dependents = [...this.getDependents(uri)];
		const keys = this.targetKeys(uri);
		for (const dependent of dependents) {
			const edges = this.outgoing.get(dependent) ?? [];
			const remaining = edges.filter((edge) => edge.to !== uri);
			if (remaining.length !== edges.length) {
				this.outgoing.set(dependent, remaining);
				for (const key of keys) {
					const candidates = this.unresolved.get(key) ?? new Set<string>();
					candidates.add(dependent);
					this.unresolved.set(key, candidates);
					const registered = this.unresolvedByUri.get(dependent) ?? new Set<string>();
					registered.add(key);
					this.unresolvedByUri.set(dependent, registered);
				}
			}
		}
		this.removeOutgoing(uri);
		this.incoming.delete(uri);
		for (const entries of this.incoming.values()) entries.delete(uri);
		this.classNames.delete(uri);
		this.forgetClassNames(uri);
		this.forgetPath(uri);
		this.indexedUris.delete(uri);
		return dependents;
	}

	clear(): void {
		this.outgoing.clear();
		this.incoming.clear();
		this.unresolved.clear();
		this.classNames.clear();
		this.unresolvedByUri.clear();
		this.classNamesByUri.clear();
		this.classNameToUris.clear();
		this.pathToUris.clear();
		this.pathsByUri.clear();
		this.indexedUris.clear();
		this.refreshing.clear();
	}

	/**
	 * Builds the class-name/path lookups from the current file index once. Files
	 * indexed before their first `update` (or never updated) must still be found,
	 * otherwise `extends Base` would only resolve if the base file happened to be
	 * updated first.
	 */
	private ensureClassIndex(): void {
		if (this.indexedUris.size === this.files.size) return;
		for (const file of this.files.values()) {
			if (this.indexedUris.has(file.uri)) continue;
			this.indexedUris.add(file.uri);
			if (!this.pathsByUri.has(file.uri)) this.rememberPath(file.uri);
			if (!this.classNamesByUri.has(file.uri)) this.rememberClassNames(file.uri);
		}
	}

	private refreshForTarget(uri: string, extraKeys: readonly string[] = []): string[] {
		const candidates = new Set<string>();
		for (const key of [...this.targetKeys(uri), ...extraKeys]) {
			for (const candidate of this.unresolved.get(key) ?? []) {
				if (candidate !== uri) candidates.add(candidate);
			}
		}
		if (!candidates.size) return [];
		this.refreshing.add(uri);
		try {
			for (const candidate of candidates) {
				if (this.refreshing.has(candidate)) continue;
				this.update(candidate);
			}
		} finally {
			this.refreshing.delete(uri);
		}
		return [...candidates];
	}

	/** Records the class names the graph last saw for a file (used for refresh bookkeeping). */
	private rememberClassNames(uri: string): void {
		this.forgetClassNames(uri);
		const names = this.classNamesOf(uri);
		if (!names.length) {
			this.classNames.delete(uri);
			return;
		}
		this.classNames.set(uri, names);
		this.classNamesByUri.set(uri, names);
		for (const name of names) {
			const entries = this.classNameToUris.get(name) ?? new Set<string>();
			entries.add(uri);
			this.classNameToUris.set(name, entries);
		}
	}

	private forgetClassNames(uri: string): void {
		const names = this.classNamesByUri.get(uri);
		if (!names) return;
		this.classNamesByUri.delete(uri);
		for (const name of names) {
			const entries = this.classNameToUris.get(name);
			if (!entries) continue;
			entries.delete(uri);
			if (!entries.size) this.classNameToUris.delete(name);
		}
	}

	private rememberPath(uri: string): void {
		const previous = this.pathsByUri.get(uri);
		if (previous !== undefined) return;
		const path = normalizePath(normalizedFilePath(uri));
		this.pathsByUri.set(uri, path);
		const key = baseName(path);
		const entries = this.pathToUris.get(key) ?? new Set<string>();
		entries.add(uri);
		this.pathToUris.set(key, entries);
	}

	private forgetPath(uri: string): void {
		const path = this.pathsByUri.get(uri);
		if (path === undefined) return;
		this.pathsByUri.delete(uri);
		const key = baseName(path);
		const entries = this.pathToUris.get(key);
		if (!entries) return;
		entries.delete(uri);
		if (!entries.size) this.pathToUris.delete(key);
	}

	private classNamesOf(uri: string): string[] {
		const file = this.files.get(uri);
		return file ? collectClassNames(file.ast.declarations) : [];
	}

	/** Resolves a project `class_name` against the current file index. */
	private resolveClassName(value: string): string | undefined {
		const matches = this.classNameToUris.get(value);
		if (!matches || matches.size !== 1) return undefined;
		return matches.values().next().value;
	}

	private addCandidate(uri: string, value: string, reason: DependencyEdge["reason"], targets: Map<string, DependencyEdge>): void {
		const target = this.resolveTarget(value);
		if (target && target !== uri) {
			targets.set(target, { from: uri, to: target, reason });
			return;
		}
		const registered = this.unresolvedByUri.get(uri) ?? new Set<string>();
		for (const key of candidateKeys(value)) {
			const candidates = this.unresolved.get(key) ?? new Set<string>();
			candidates.add(uri);
			this.unresolved.set(key, candidates);
			registered.add(key);
		}
		this.unresolvedByUri.set(uri, registered);
	}

	private removeOutgoing(uri: string): void {
		const registered = this.unresolvedByUri.get(uri);
		if (registered) {
			this.unresolvedByUri.delete(uri);
			for (const key of registered) {
				const candidates = this.unresolved.get(key);
				if (!candidates) continue;
				candidates.delete(uri);
				if (!candidates.size) this.unresolved.delete(key);
			}
		}
		for (const edge of this.outgoing.get(uri) ?? []) {
			const dependents = this.incoming.get(edge.to);
			dependents?.delete(uri);
			if (dependents?.size === 0) this.incoming.delete(edge.to);
		}
		this.outgoing.delete(uri);
	}

	private resolveTarget(value: string): string | undefined {
		const path = normalizePath(value);
		const byPath = this.files.findByPathSuffix(path);
		if (value.startsWith("res://") || value.endsWith(".gd") || path.includes("/")) {
			if (byPath) return byPath;
		}
		const named = this.resolveClassName(value.split(".")[0]);
		if (named) return named;
		const name = value.split("/").pop()?.replace(/\.gd$/, "");
		if (!name) return undefined;
		const matches = this.pathToUris.get(`${name}.gd`);
		if (matches?.size === 1) return matches.values().next().value;
		return undefined;
	}

	private targetKeys(uri: string): string[] {
		const path = this.pathsByUri.get(uri) ?? normalizePath(normalizedFilePath(uri));
		const name = path.split("/").pop();
		return [...(name && name !== path ? [path, name] : [path]), ...(this.classNames.get(uri) ?? this.classNamesOf(uri))];
	}
}
