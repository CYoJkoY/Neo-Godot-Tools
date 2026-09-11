import { GDScriptDeclaration, GDScriptFunction, GDScriptToken, SourceRange, lexGDScript } from "../analyzer/index.js";
import { FileIndex, IndexedFile } from "./file_index";
import { IndexedSymbol } from "./symbol";

export type BindingKind = "parameter" | "local" | "member" | "function" | "class" | "constant" | "class_name" | "signal" | "enum";

export interface Binding {
	id: string;
	name: string;
	kind: BindingKind;
	uri: string;
	declarationRange: SourceRange;
	scopeRange: SourceRange;
	containerName?: string;
	type?: string;
	returnType?: string;
}

export interface BoundReference {
	bindingId: string;
	name: string;
	uri: string;
	range: SourceRange;
}

interface Scope {
	range: SourceRange;
	parent?: Scope;
	children: Scope[];
	bindings: Map<string, Binding[]>;
}

function contains(range: SourceRange, offset: number): boolean {
	return range.start.offset <= offset && offset <= range.end.offset;
}

function tokenRange(token: GDScriptToken): SourceRange {
	return {
		start: { offset: token.start, line: token.line, character: token.character },
		end: { offset: token.end, line: token.line, character: token.character + token.end - token.start },
	};
}

function bindingKind(symbol: IndexedSymbol): BindingKind | undefined {
	switch (symbol.kind) {
		case "variable": return "member";
		case "function": return "function";
		case "class": return "class";
		case "constant": return "constant";
		case "class_name": return "class_name";
		case "signal": return "signal";
		case "enum": return "enum";
		default: return undefined;
	}
}

function addBinding(scope: Scope, binding: Binding): void {
	const entries = scope.bindings.get(binding.name) ?? [];
	entries.push(binding);
	scope.bindings.set(binding.name, entries);
}

function addParameters(scope: Scope, fn: GDScriptFunction, uri: string): void {
	for (const parameter of fn.parameters) addBinding(scope, {
		id: `${uri}:${parameter.range.start.offset}`,
		name: parameter.name,
		kind: "parameter",
		uri,
		declarationRange: parameter.range,
		scopeRange: scope.range,
		type: parameter.type,
	});
}

function addLocalDeclarations(source: string, fn: GDScriptFunction, scope: Scope, uri: string): void {
	if (!fn.bodyRange) return;
	const tokens = lexGDScript(source);
	for (let index = 1; index < tokens.length; index++) {
		const token = tokens[index];
		const previous = tokens[index - 1];
		if (token.start < fn.bodyRange.start.offset || token.end > fn.bodyRange.end.offset) continue;
		if (token.kind !== "identifier" || (previous.value !== "var" && previous.value !== "const") || previous.line !== token.line) continue;
		const next = tokens[index + 1];
		const type = next?.value === ":" ? tokens[index + 2]?.value : undefined;
		addBinding(scope, {
			id: `${uri}:${token.start}`,
			name: token.value,
			kind: "local",
			uri,
			declarationRange: tokenRange(token),
			scopeRange: scope.range,
			type,
		});
	}
}

function createScope(range: SourceRange, parent?: Scope): Scope {
	const scope: Scope = { range, parent, children: [], bindings: new Map() };
	parent?.children.push(scope);
	return scope;
}

function buildScopes(source: string, file: IndexedFile, uri: string): Scope {
	const root = createScope(file.ast.range);
	for (const symbol of file.symbols) {
		const kind = bindingKind(symbol);
		if (kind && !symbol.containerName) addBinding(root, {
			id: `${uri}:${symbol.range.start.offset}`,
			name: symbol.name,
			kind,
			uri,
			declarationRange: symbol.range,
			scopeRange: root.range,
			type: symbol.type,
			returnType: symbol.returnType,
		});
	}

	const visit = (declarations: GDScriptDeclaration[], parent: Scope) => {
		for (const declaration of declarations) {
			if (declaration.kind === "class") {
				const classScope = createScope(declaration.range, parent);
				for (const symbol of file.symbols) {
					if (symbol.containerName !== declaration.name) continue;
					const kind = bindingKind(symbol);
					if (kind) addBinding(classScope, {
						id: `${uri}:${symbol.range.start.offset}`,
						name: symbol.name,
						kind,
						uri,
						declarationRange: symbol.range,
						scopeRange: classScope.range,
						containerName: declaration.name,
						type: symbol.type,
						returnType: symbol.returnType,
					});
				}
				visit(declaration.declarations, classScope);
				continue;
			}
			if (declaration.kind !== "function") continue;
			const functionScope = createScope(declaration.range, parent);
			addParameters(functionScope, declaration, uri);
			addLocalDeclarations(source, declaration, functionScope, uri);
		}
	};
	visit(file.ast.declarations, root);
	return root;
}

function findInnermostScope(scope: Scope, offset: number): Scope {
	for (const child of scope.children) if (contains(child.range, offset)) return findInnermostScope(child, offset);
	return scope;
}

function findBinding(scope: Scope, name: string, offset: number): Binding | undefined {
	const entries = scope.bindings.get(name) ?? [];
	const visible = entries.filter((binding) => contains(binding.scopeRange, offset));
	if (!visible.length) return undefined;
	const declarationsBefore = visible.filter((binding) => binding.declarationRange.start.offset <= offset);
	return declarationsBefore[declarationsBefore.length - 1] ?? visible[0];
}

const nonReferenceIdentifiers = new Set([
	"and", "as", "await", "breakpoint", "break", "class_name", "class", "const", "continue", "elif", "else",
	"enum", "extends", "false", "for", "func", "if", "in", "is", "match", "not", "null", "or", "pass",
	"preload", "return", "self", "signal", "static", "super", "true", "var", "void", "while", "when",
]);

export class BindingIndex {
	private readonly bindings = new Map<string, Binding[]>();
	private readonly references = new Map<string, BoundReference[]>();
	private readonly scopes = new Map<string, Scope>();

	constructor(private readonly files: FileIndex) {}

	update(uri: string): void {
		this.remove(uri);
		const file = this.files.get(uri);
		if (!file) return;
		const root = buildScopes(file.source, file, uri);
		this.scopes.set(uri, root);
		for (const binding of this.allBindings(root)) {
			const entries = this.bindings.get(binding.name) ?? [];
			entries.push(binding);
			this.bindings.set(binding.name, entries);
		}
		this.references.set(uri, this.resolveReferences(file.source, uri));
	}

	getBinding(uri: string, offset: number, name: string): Binding | undefined {
		const root = this.scopes.get(uri);
		if (!root) return undefined;
		let scope: Scope | undefined = findInnermostScope(root, offset);
		while (scope) {
			const binding = findBinding(scope, name, offset);
			if (binding) return binding;
			scope = scope.parent;
		}
		const global = this.bindings.get(name) ?? [];
		return global.length === 1 ? global[0] : undefined;
	}

	getVisibleBindings(uri: string, offset: number): Binding[] {
		const root = this.scopes.get(uri);
		if (!root) return [];
		const result: Binding[] = [];
		const names = new Set<string>();
		let scope: Scope | undefined = findInnermostScope(root, offset);
		while (scope) {
			for (const [name, entries] of scope.bindings) {
				if (names.has(name)) continue;
				const binding = findBinding(scope, name, offset);
				if (!binding) continue;
				names.add(name);
				result.push(binding);
			}
			scope = scope.parent;
		}
		return result;
	}

	findReferences(bindingId: string): BoundReference[] {
		const result: BoundReference[] = [];
		for (const refs of this.references.values()) for (const reference of refs) if (reference.bindingId === bindingId) result.push(reference);
		return result;
	}

	remove(uri: string): void {
		this.scopes.delete(uri);
		this.references.delete(uri);
		for (const [name, entries] of this.bindings) {
			const remaining = entries.filter((binding) => binding.uri !== uri);
			if (remaining.length) this.bindings.set(name, remaining);
			else this.bindings.delete(name);
		}
	}

	clear(): void {
		this.bindings.clear();
		this.references.clear();
		this.scopes.clear();
	}

	private allBindings(scope: Scope): Binding[] {
		return [...scope.bindings.values()].flat().concat(...scope.children.map((child) => this.allBindings(child)));
	}

	private resolveReferences(source: string, uri: string): BoundReference[] {
		const tokens = lexGDScript(source);
		const result: BoundReference[] = [];
		for (let index = 0; index < tokens.length; index++) {
			const token = tokens[index];
			if (token.kind !== "identifier" || nonReferenceIdentifiers.has(token.value)) continue;
			const previous = tokens[index - 1]?.value;
			const previousPrevious = tokens[index - 2]?.value;
			if (previous === "." && previousPrevious !== "self") continue;
			const binding = this.getBinding(uri, token.start, token.value);
			if (!binding) continue;
			result.push({ bindingId: binding.id, name: token.value, uri, range: tokenRange(token) });
		}
		return result;
	}
}
