import { GDScriptDeclaration, GDScriptFunction, GDScriptToken, SourceRange, lexGDScript } from "../analyzer/index.js";
import { FileIndex } from "./file_index";
import { IndexedFile, IndexedSymbol } from "./symbol";

export type BindingKind = "parameter" | "local" | "member" | "function" | "class" | "constant" | "class_name" | "signal" | "enum" | "enum_member";

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

type ScopeKind = "root" | "class" | "function";

interface Scope {
	range: SourceRange;
	kind: ScopeKind;
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
	case "enum_member": return "enum_member";
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

function createScope(range: SourceRange, kind: ScopeKind, parent?: Scope): Scope {
	const scope: Scope = { range, kind, parent, children: [], bindings: new Map() };
	parent?.children.push(scope);
	return scope;
}

function buildScopes(source: string, file: IndexedFile, uri: string): Scope {
	const root = createScope(file.ast.range, "root");
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
				const classScope = createScope(declaration.range, "class", parent);
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
			const functionScope = createScope(declaration.range, "function", parent);
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
	private readonly byUri = new Map<string, Binding[]>();
	private readonly references = new Map<string, BoundReference[]>();
	private readonly referencesByBinding = new Map<string, BoundReference[]>();
	private readonly scopes = new Map<string, Scope>();

	constructor(private readonly files: FileIndex) {}

	update(uri: string): void {
		this.remove(uri);
		const file = this.files.get(uri);
		if (!file) return;
		const root = buildScopes(file.source, file, uri);
		this.scopes.set(uri, root);
		const bindings = this.allBindings(root);
		this.byUri.set(uri, bindings);
		for (const binding of bindings) {
			const entries = this.bindings.get(binding.name) ?? [];
			entries.push(binding);
			this.bindings.set(binding.name, entries);
		}
		const references = this.resolveReferences(file.source, uri);
		this.references.set(uri, references);
		for (const reference of references) {
			const entries = this.referencesByBinding.get(reference.bindingId) ?? [];
			entries.push(reference);
			this.referencesByBinding.set(reference.bindingId, entries);
		}
	}

	getBinding(uri: string, offset: number, name: string): Binding | undefined {
		return this.resolveBinding(uri, offset, name, true);
	}

	/**
	 * Resolves a member access such as `self.health`. Function scopes are skipped
	 * so a parameter or local variable that shadows a script member does not
	 * capture the reference.
	 */
	getMemberBinding(uri: string, offset: number, name: string): Binding | undefined {
		return this.resolveBinding(uri, offset, name, false);
	}

	private resolveBinding(uri: string, offset: number, name: string, allowFunctionScopes: boolean): Binding | undefined {
		const root = this.scopes.get(uri);
		if (!root) return undefined;
		let scope: Scope | undefined = findInnermostScope(root, offset);
		while (scope) {
			if (allowFunctionScopes || scope.kind !== "function") {
				const binding = findBinding(scope, name, offset);
				if (binding) return binding;
			}
			scope = scope.parent;
		}
		const global = this.bindings.get(name) ?? [];
		return global.length === 1 ? global[0] : undefined;
	}

	/**
	 * Bindings visible at `offset`, ordered by completion priority: innermost
	 * scope first, then enclosing scopes, and inside a scope by declaration order.
	 */
	getVisibleBindings(uri: string, offset: number): Binding[] {
		const root = this.scopes.get(uri);
		if (!root) return [];
		const result: Binding[] = [];
		const names = new Set<string>();
		let scope: Scope | undefined = findInnermostScope(root, offset);
		while (scope) {
			const visible: Binding[] = [];
			for (const [name] of scope.bindings) {
				if (names.has(name)) continue;
				const binding = findBinding(scope, name, offset);
				if (!binding) continue;
				names.add(name);
				visible.push(binding);
			}
			visible.sort((left, right) => left.declarationRange.start.offset - right.declarationRange.start.offset);
			result.push(...visible);
			scope = scope.parent;
		}
		return result;
	}

	findReferences(bindingId: string): BoundReference[] {
		// Indexed by binding id: scanning every reference of every file here made
		// rename/find-references quadratic on large workspaces.
		return [...(this.referencesByBinding.get(bindingId) ?? [])];
	}

	remove(uri: string): void {
		this.scopes.delete(uri);
		const references = this.references.get(uri);
		if (references) {
			for (const reference of references) {
				const entries = this.referencesByBinding.get(reference.bindingId);
				if (!entries) continue;
				const remaining = entries.filter((entry) => entry.uri !== uri || entry.range.start.offset !== reference.range.start.offset);
				if (remaining.length) this.referencesByBinding.set(reference.bindingId, remaining);
				else this.referencesByBinding.delete(reference.bindingId);
			}
			this.references.delete(uri);
		}
		const own = this.byUri.get(uri);
		if (own) {
			this.byUri.delete(uri);
			for (const binding of own) {
				const entries = this.bindings.get(binding.name);
				if (!entries) continue;
				const remaining = entries.filter((entry) => entry.uri !== uri || entry.declarationRange.start.offset !== binding.declarationRange.start.offset);
				if (remaining.length) this.bindings.set(binding.name, remaining);
				else this.bindings.delete(binding.name);
			}
		}
	}

	clear(): void {
		this.bindings.clear();
		this.byUri.clear();
		this.references.clear();
		this.referencesByBinding.clear();
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
			if (previous === ".") {
				const previousPrevious = tokens[index - 2]?.value;
				if (previousPrevious === "self") {
					// `self.member` always addresses the script member, never a local
					// variable or parameter with the same name.
					const member = this.getMemberBinding(uri, token.start, token.value);
					if (!member) continue;
					result.push({ bindingId: member.id, name: token.value, uri, range: tokenRange(token) });
				} else if (previousPrevious === "super") {
					const member = this.resolveSuperMember(uri, token.value);
					if (member) result.push({ bindingId: member.id, name: token.value, uri, range: tokenRange(token) });
				} else if (previousPrevious === "]" || !previousPrevious) {
					// Dynamic access (`rows[i].name`) is resolved by the language
					// server, not by the local index.
					continue;
				} else {
					// `Worker.run()` / `A.B.run()`: bind the access to the member of the
					// named class so find-references and rename cover inner classes.
					const member = this.resolveClassMember(uri, token.start, previousPrevious, token.value);
					if (member) result.push({ bindingId: member.id, name: token.value, uri, range: tokenRange(token) });
				}
				continue;
			}
			const binding = this.getBinding(uri, token.start, token.value);
			if (!binding) continue;
			result.push({ bindingId: binding.id, name: token.value, uri, range: tokenRange(token) });
		}
		return result;
	}

	/**
	 * The member addressed through `receiver.member`, where the receiver is a
	 * class name (`Worker.run()`), a nested class (`A.B.run()`) or a variable
	 * whose type is known (`var w := Worker.new(); w.run()`).
	 */
	private resolveClassMember(uri: string, offset: number, receiverName: string, memberName: string): Binding | undefined {
		const file = this.files.get(uri);
		if (!file || !/^[A-Za-z_]\w*$/.test(receiverName)) return undefined;
		const direct = this.classCandidate(file, offset, receiverName);
		if (direct) {
			const member = this.findClassMember(uri, direct, memberName, new Set<string>());
			if (member) return this.bindingFromSymbol(member, direct.range);
		}
		const inferred = this.inferReceiverTypeName(uri, offset, receiverName);
		if (!inferred) return undefined;
		const candidate = this.classCandidate(file, offset, inferred) ?? this.globalClassCandidate(inferred);
		if (!candidate) return undefined;
		const member = this.findClassMember(candidate.uri, candidate, memberName, new Set<string>());
		return member ? this.bindingFromSymbol(member, candidate.range) : undefined;
	}

	/** A class declaration named `name` visible at `offset`, preferring the innermost. */
	private classCandidate(file: IndexedFile, offset: number, name: string): IndexedSymbol | undefined {
		const candidates = file.symbols.filter((symbol) => symbol.kind === "class" && symbol.name === name);
		if (!candidates.length) return undefined;
		const enclosing = candidates
			.filter((symbol) => symbol.range.start.offset <= offset && offset <= symbol.range.end.offset)
			.sort((left, right) => right.range.start.offset - left.range.start.offset);
		return enclosing[0] ?? candidates.find((symbol) => !symbol.containerName) ?? (candidates.length === 1 ? candidates[0] : undefined);
	}

	private globalClassCandidate(name: string): IndexedSymbol | undefined {
		const declarations = (this.bindings.get(name) ?? []).filter((binding) => binding.kind === "class_name");
		if (declarations.length !== 1) return undefined;
		const file = this.files.get(declarations[0].uri);
		return file?.symbols.find((symbol) => symbol.kind === "class_name" && symbol.name === name);
	}

	/** Infers the class a variable holds from its explicit type or `X.new()`. */
	private inferReceiverTypeName(uri: string, offset: number, receiverName: string): string | undefined {
		const binding = this.getBinding(uri, offset, receiverName) ?? this.getMemberBinding(uri, offset, receiverName);
		if (!binding) return undefined;
		const explicit = binding.type?.match(/^([A-Za-z_]\w*)/)?.[1];
		if (explicit && explicit !== "Array" && explicit !== "Dictionary") return explicit;
		const file = this.files.get(uri);
		if (!file) return undefined;
		const lineEnd = file.source.indexOf("\n", binding.declarationRange.start.offset);
		const declaration = file.source.slice(binding.declarationRange.start.offset, lineEnd < 0 ? undefined : lineEnd);
		const constructed = declaration.match(/=\s*(?:preload\s*\([^)]*\)\s*\.\s*)?([A-Za-z_]\w*)\s*\.\s*new\s*\(/);
		if (constructed) return constructed[1];
		const typed = declaration.match(/^[^=]*:\s*([A-Za-z_]\w*)/);
		return typed?.[1];
	}

	/** Looks up `name` on a class, following its `extends` chain. */
	private findClassMember(uri: string, classSymbol: IndexedSymbol, name: string, visited: Set<string>): IndexedSymbol | undefined {
		const key = `${uri}#${classSymbol.range.start.offset}`;
		if (visited.has(key)) return undefined;
		visited.add(key);
		const file = this.files.get(uri);
		if (!file) return undefined;
		const belongs = (symbol: IndexedSymbol) => {
			if (symbol.kind === "class_name") return false;
			if (classSymbol.kind === "class_name") return !symbol.containerRange && !symbol.containerName;
			if (symbol.containerRange) return symbol.containerRange.start.offset === classSymbol.range.start.offset;
			return Boolean(symbol.containerName) && symbol.containerName === classSymbol.name;
		};
		const own = file.symbols.find((symbol) => symbol.name === name && belongs(symbol));
		if (own) return own;
		const reference = classSymbol.extendsName?.replace(/^["']|["']$/g, "");
		if (reference) {
			const base = this.classCandidate(file, classSymbol.range.start.offset, reference);
			const baseMember = base ? this.findClassMember(uri, base, name, visited) : undefined;
			if (baseMember) return baseMember;
			if (reference.startsWith("res://") || reference.endsWith(".gd")) {
				const baseUri = this.files.findByPathSuffix(reference);
				const baseFile = baseUri ? this.files.get(baseUri) : undefined;
				const baseClass = baseFile?.symbols.find((symbol) => symbol.kind === "class_name");
				if (baseUri && baseClass) return this.findClassMember(baseUri, baseClass, name, visited);
			}
		}
		if (classSymbol.kind === "class_name") return undefined;
		// A script-level class may extend another script (`extends Base`).
		const scriptBase = file.symbols.find((symbol) => symbol.kind === "class_name");
		if (!scriptBase || scriptBase === classSymbol) return undefined;
		const extendsDeclaration = file.ast.declarations.find((declaration) => declaration.kind === "extends");
		const scriptReference = extendsDeclaration?.kind === "extends" ? extendsDeclaration.name.replace(/^["']|["']$/g, "") : undefined;
		if (!scriptReference || (!scriptReference.startsWith("res://") && !scriptReference.endsWith(".gd"))) return undefined;
		const baseUri = this.files.findByPathSuffix(scriptReference);
		const baseFile = baseUri ? this.files.get(baseUri) : undefined;
		const baseClass = baseFile?.symbols.find((symbol) => symbol.kind === "class_name");
		return baseUri && baseClass ? this.findClassMember(baseUri, baseClass, name, visited) : undefined;
	}

	/** The base-class member addressed by `super.name`. */
	private resolveSuperMember(uri: string, name: string): Binding | undefined {
		const file = this.files.get(uri);
		if (!file) return undefined;
		const extendsDeclaration = file.ast.declarations.find((declaration) => declaration.kind === "extends");
		const reference = extendsDeclaration?.kind === "extends" ? extendsDeclaration.name.replace(/^["']|["']$/g, "") : undefined;
		if (!reference) return undefined;
		if (reference.startsWith("res://") || reference.endsWith(".gd")) {
			const baseUri = this.files.findByPathSuffix(reference);
			const baseFile = baseUri ? this.files.get(baseUri) : undefined;
			const symbol = baseFile?.symbols.find((candidate) => candidate.name === name && !candidate.containerName && candidate.kind !== "class_name");
			return symbol ? this.bindingFromSymbol(symbol, symbol.range) : undefined;
		}
		const baseClass = this.globalClassCandidate(reference);
		if (!baseClass) return undefined;
		const baseFile = this.files.get(baseClass.uri);
		const member = baseFile?.symbols.find((candidate) => candidate.name === name && !candidate.containerName && candidate.kind !== "class_name");
		return member ? this.bindingFromSymbol(member, baseClass.range) : undefined;
	}

	private bindingFromSymbol(symbol: IndexedSymbol, scopeRange: SourceRange): Binding | undefined {
		const kind = bindingKind(symbol);
		if (!kind) return undefined;
		return {
			// The same id the scope builder assigned, so references and rename match.
			id: `${symbol.uri}:${symbol.range.start.offset}`,
			name: symbol.name,
			kind,
			uri: symbol.uri,
			declarationRange: symbol.range,
			scopeRange,
			containerName: symbol.containerName,
			type: symbol.type,
			returnType: symbol.returnType,
		};
	}
}
