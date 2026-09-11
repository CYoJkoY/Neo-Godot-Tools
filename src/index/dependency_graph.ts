import { GDScriptDeclaration } from "../analyzer/index.js";
import { FileIndex } from "./file_index.js";

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

export class DependencyGraph {
	private readonly outgoing = new Map<string, DependencyEdge[]>();
	private readonly incoming = new Map<string, Set<string>>();
	private readonly unresolved = new Map<string, Set<string>>();

	constructor(private readonly files: FileIndex) {}

	update(uri: string): string[] {
		this.removeOutgoing(uri);
		const file = this.files.get(uri);
		if (!file) return [];
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
		return this.refreshForTarget(uri);
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
		const dependents = this.getDependents(uri);
		for (const dependent of dependents) {
			const edges = this.outgoing.get(dependent) ?? [];
			const remaining = edges.filter((edge) => edge.to !== uri);
			if (remaining.length !== edges.length) {
				this.outgoing.set(dependent, remaining);
				for (const key of this.targetKeys(uri)) {
					const candidates = this.unresolved.get(key) ?? new Set<string>();
					candidates.add(dependent);
					this.unresolved.set(key, candidates);
				}
			}
		}
		this.removeOutgoing(uri);
		this.incoming.delete(uri);
		for (const entries of this.incoming.values()) entries.delete(uri);
		return dependents;
	}

	clear(): void {
		this.outgoing.clear();
		this.incoming.clear();
		this.unresolved.clear();
	}

	private refreshForTarget(uri: string): string[] {
		const candidates = new Set<string>();
		for (const key of this.targetKeys(uri)) {
			for (const candidate of this.unresolved.get(key) ?? []) candidates.add(candidate);
		}
		for (const candidate of candidates) this.update(candidate);
		return [...candidates];
	}

	private addCandidate(uri: string, value: string, reason: DependencyEdge["reason"], targets: Map<string, DependencyEdge>): void {
		const target = this.resolveTarget(value);
		if (target && target !== uri) {
			targets.set(target, { from: uri, to: target, reason });
			return;
		}
		for (const key of candidateKeys(value)) {
			const candidates = this.unresolved.get(key) ?? new Set<string>();
			candidates.add(uri);
			this.unresolved.set(key, candidates);
		}
	}

	private removeOutgoing(uri: string): void {
		for (const edge of this.outgoing.get(uri) ?? []) {
			const dependents = this.incoming.get(edge.to);
			dependents?.delete(uri);
			if (dependents?.size === 0) this.incoming.delete(edge.to);
		}
		this.outgoing.delete(uri);
		for (const candidates of this.unresolved.values()) candidates.delete(uri);
		for (const [key, candidates] of this.unresolved) if (candidates.size === 0) this.unresolved.delete(key);
	}

	private resolveTarget(value: string): string | undefined {
		const path = normalizePath(value);
		if (value.startsWith("res://")) {
			const matches = [...this.files.values()].filter((file) => normalizePath(this.pathFromUri(file.uri)).endsWith(path));
			return matches.length === 1 ? matches[0].uri : undefined;
		}
		const name = value.split("/").pop()?.replace(/\.gd$/, "");
		if (!name) return undefined;
		const matches = [...this.files.values()].filter((file) => this.pathFromUri(file.uri).endsWith(`/${name}.gd`));
		return matches.length === 1 ? matches[0].uri : undefined;
	}

	private targetKeys(uri: string): string[] {
		const path = normalizePath(this.pathFromUri(uri));
		const name = path.split("/").pop();
		return name && name !== path ? [path, name] : [path];
	}

	private pathFromUri(uri: string): string {
		try { return decodeURIComponent(new URL(uri).pathname).replace(/^\/+/, ""); } catch { return uri; }
	}
}
