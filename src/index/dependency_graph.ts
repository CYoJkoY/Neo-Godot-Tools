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
	const pattern = /preload\s*\(\s*[\"']([^\"']+)[\"']\s*\)/g;
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

export class DependencyGraph {
	private readonly outgoing = new Map<string, DependencyEdge[]>();
	private readonly incoming = new Map<string, Set<string>>();

	constructor(private readonly files: FileIndex) {}

	update(uri: string): void {
		this.remove(uri);
		const file = this.files.get(uri);
		if (!file) return;
		const targets = new Map<string, DependencyEdge>();
		for (const value of collectExtends(file.ast.declarations)) {
			const target = this.resolveTarget(value);
			if (target && target !== uri) targets.set(target, { from: uri, to: target, reason: "extends" });
		}
		for (const value of collectPreloads(file.source)) {
			const target = this.resolveTarget(value);
			if (target && target !== uri) targets.set(target, { from: uri, to: target, reason: "preload" });
		}
		const edges = [...targets.values()];
		this.outgoing.set(uri, edges);
		for (const edge of edges) {
			const dependents = this.incoming.get(edge.to) ?? new Set<string>();
			dependents.add(uri);
			this.incoming.set(edge.to, dependents);
		}
	}

	getDependencies(uri: string): readonly DependencyEdge[] { return this.outgoing.get(uri) ?? []; }
	getDependents(uri: string): readonly string[] { return [...(this.incoming.get(uri) ?? [])]; }

	remove(uri: string): void {
		for (const edge of this.outgoing.get(uri) ?? []) {
			const dependents = this.incoming.get(edge.to);
			dependents?.delete(uri);
			if (dependents?.size === 0) this.incoming.delete(edge.to);
		}
		this.outgoing.delete(uri);
		this.incoming.delete(uri);
		for (const dependents of this.incoming.values()) dependents.delete(uri);
	}

	clear(): void {
		this.outgoing.clear();
		this.incoming.clear();
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

	private pathFromUri(uri: string): string {
		try { return decodeURIComponent(new URL(uri).pathname).replace(/^\/+/, ""); } catch { return uri; }
	}
}
