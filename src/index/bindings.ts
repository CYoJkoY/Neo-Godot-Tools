import { GDScriptDeclaration, GDScriptFunction, GDScriptToken, SourceRange } from "../analyzer/index.js";
import { ChainLink, parseChainEndingAt } from "./expression.js";
import { FileIndex } from "./file_index";
import { IndexedFile, IndexedSymbol } from "./symbol";
import { tokensFor } from "./token_cache.js";

export type BindingKind = "parameter" | "local" | "member" | "function" | "class" | "constant" | "class_name" | "signal" | "enum" | "enum_member";

export interface Binding {
	id: string;
	name: string;
	kind: BindingKind;
	uri: string;
	declarationRange: SourceRange;
	/** Offset of the declaring identifier; `declarationRange` may start earlier. */
	nameOffset: number;
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

/** Type after `:`: `Outer.Inner`, `Array[int]`, `Callable`. */
function readTypeName(tokens: readonly GDScriptToken[], start: number): string | undefined {
	const parts: string[] = [];
	for (let index = start; index < tokens.length; index++) {
		const token = tokens[index];
		const value = token.value;
		if (token.kind === "identifier") {
			if (parts.length && parts[parts.length - 1] !== ".") break;
			parts.push(value);
			continue;
		}
		if (value === ".") {
			if (!parts.length || parts[parts.length - 1] === ".") break;
			parts.push(value);
			continue;
		}
		break;
	}
	return parts.length ? parts.join("") : undefined;
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
		nameOffset: parameter.range.start.offset,
		scopeRange: scope.range,
		type: parameter.type,
	});
}

function addLocalDeclarations(tokens: readonly GDScriptToken[], fn: GDScriptFunction, scope: Scope, uri: string): void {
	if (!fn.bodyRange) return;
	for (let index = 1; index < tokens.length; index++) {
		const token = tokens[index];
		const previous = tokens[index - 1];
		if (token.start < fn.bodyRange.start.offset || token.end > fn.bodyRange.end.offset) continue;
		if (token.kind !== "identifier" || (previous.value !== "var" && previous.value !== "const") || previous.line !== token.line) continue;
		const type = tokens[index + 1]?.value === ":" ? readTypeName(tokens, index + 2) : undefined;
		addBinding(scope, {
			id: `${uri}:${token.start}`,
			name: token.value,
			kind: "local",
			uri,
			declarationRange: tokenRange(token),
			nameOffset: token.start,
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

function buildScopes(file: IndexedFile, uri: string): Scope {
	const tokens = tokensFor(uri, file.source, file.sourceFingerprint);
	const root = createScope(file.ast.range, "root");
	for (const symbol of file.symbols) {
		const kind = bindingKind(symbol);
		if (kind && !symbol.containerName) addBinding(root, {
			id: `${uri}:${symbol.nameOffset ?? symbol.range.start.offset}`,
			name: symbol.name,
			kind,
			uri,
			declarationRange: symbol.range,
			nameOffset: symbol.nameOffset ?? symbol.range.start.offset,
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
						id: `${uri}:${symbol.nameOffset ?? symbol.range.start.offset}`,
						name: symbol.name,
						kind,
						uri,
						declarationRange: symbol.range,
						nameOffset: symbol.nameOffset ?? symbol.range.start.offset,
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
			addLocalDeclarations(tokens, declaration, functionScope, uri);
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
		const root = buildScopes(file, uri);
		this.scopes.set(uri, root);
		const bindings = this.allBindings(root);
		this.byUri.set(uri, bindings);
		for (const binding of bindings) {
			const entries = this.bindings.get(binding.name) ?? [];
			entries.push(binding);
			this.bindings.set(binding.name, entries);
		}
		const references = this.resolveReferences(tokensFor(uri, file.source, file.sourceFingerprint), uri);
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
				const remaining = entries.filter((entry) => entry.id !== binding.id);
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

	private resolveReferences(tokens: readonly GDScriptToken[], uri: string): BoundReference[] {
		const result: BoundReference[] = [];
		for (let index = 0; index < tokens.length; index++) {
			const token = tokens[index];
			if (token.kind !== "identifier" || nonReferenceIdentifiers.has(token.value)) continue;
			const previous = tokens[index - 1]?.value;
			if (previous === ".") {
				const previousPrevious = tokens[index - 2]?.value;
				if (previousPrevious === "self") {
					// `self.member` always addresses a class member, never a local
					// variable or parameter with the same name. Inside an inner class
					// the member may be inherited (`self.ping()` → `Base.ping`), which
					// the plain scope lookup cannot see.
					const scopeMember = this.getMemberBinding(uri, token.start, token.value);
					const chain = scopeMember ? undefined : parseChainEndingAt(tokens, tokens[index - 1].start);
					const member = scopeMember ?? (chain ? this.resolveChainMember(uri, token.start, chain, token.value) : undefined);
					if (!member) continue;
					result.push({ bindingId: member.id, name: token.value, uri, range: tokenRange(token) });
					continue;
				}
				if (previousPrevious === "super") {
					const member = this.resolveSuperMember(uri, token.start, token.value);
					if (member) result.push({ bindingId: member.id, name: token.value, uri, range: tokenRange(token) });
					continue;
				}
				// `Worker.run()`, `A.Inner.run()`, `Worker.new().run()` and
				// `make().run()` all bind to the member of the class behind the
				// receiver expression, so find-references and rename cover nested
				// classes instead of falling back to a name guess.
				const chain = parseChainEndingAt(tokens, tokens[index - 1].start);
				const member = chain ? this.resolveChainMember(uri, token.start, chain, token.value) : undefined;
				if (member) result.push({ bindingId: member.id, name: token.value, uri, range: tokenRange(token) });
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
	 * chain of accesses: a class name (`Worker.run()`), a nested class
	 * (`A.B.run()`), a constructed instance (`Worker.new().run()`) or a call
	 * result (`make().run()`).
	 */
	private resolveChainMember(uri: string, offset: number, chain: readonly ChainLink[], memberName: string): Binding | undefined {
		const owner = this.chainClass(uri, offset, chain);
		if (!owner) return undefined;
		const member = this.findClassMember(owner.uri, owner, memberName, new Set<string>());
		return member ? this.bindingFromSymbol(member, owner.range) : undefined;
	}

	/**
	 * Class declaration a receiver chain belongs to, or `undefined` when any
	 * link of the chain has an unknown type.
	 */
	private chainClass(uri: string, offset: number, chain: readonly ChainLink[]): IndexedSymbol | undefined {
		const file = this.files.get(uri);
		if (!file || !chain.length) return undefined;
		let current: IndexedSymbol | undefined;
		for (let index = 0; index < chain.length; index++) {
			const link = chain[index];
			if (index === 0) {
				current = this.namedClass(file, link.name, offset);
				if (!current && !link.call) {
					const inferred = this.inferReceiverTypeName(uri, offset, link.name);
					current = inferred ? this.namedClass(file, inferred, offset) : undefined;
				}
				if (!current && !link.call && link.name === "self") current = this.containingClass(file, offset);
				if (!current) return undefined;
				continue;
			}
			// `Type.new(...)` constructs the class the chain already resolved to.
			if (link.call && link.name === "new") continue;
			if (!current) return undefined;
			const member = this.findClassMember(current.uri, current, link.name, new Set<string>());
			if (!member) return undefined;
			const typeName = link.call ? member.returnType : member.type ?? member.name;
			if (!typeName) return undefined;
			const normalized = typeName.replace(/^([A-Za-z_]\w*).*$/, "$1");
			const next = this.namedClass(file, normalized, offset) ?? this.classCandidateOf(current.uri, normalized, offset);
			if (!next) return undefined;
			current = next;
		}
		return current;
	}

	private classCandidateOf(uri: string, name: string, offset: number): IndexedSymbol | undefined {
		const file = this.files.get(uri);
		return file ? this.namedClass(file, name, offset) : undefined;
	}

	private namedClass(file: IndexedFile, name: string, offset: number): IndexedSymbol | undefined {
		return this.classCandidate(file, offset, name) ?? this.globalClassCandidate(name);
	}

	/** Innermost class declaration containing `offset`. */
	private containingClass(file: IndexedFile, offset: number): IndexedSymbol | undefined {
		const classes = file.symbols.filter((symbol) => symbol.kind === "class" && symbol.range.start.offset <= offset && offset <= symbol.range.end.offset);
		return classes.sort((left, right) => right.range.start.offset - left.range.start.offset)[0];
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
		const explicit = binding.type?.match(/^([A-Za-z_]\w*(?:\.[A-Za-z_]\w*)*)/)?.[1];
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
	private resolveSuperMember(uri: string, offset: number, name: string): Binding | undefined {
		const file = this.files.get(uri);
		if (!file) return undefined;
		// Inside an inner class `super` is that class's own base, not the script's.
		const containing = this.containingClass(file, offset);
		if (containing?.extendsName) {
			const base = this.classFromReference(file, offset, containing.extendsName);
			const member = base ? this.findClassMember(base.uri, base, name, new Set<string>()) : undefined;
			if (base && member) return this.bindingFromSymbol(member, base.range);
		}
		const scriptBase = this.scriptBaseClass(file);
		const member = scriptBase ? this.findClassMember(scriptBase.uri, scriptBase, name, new Set<string>()) : undefined;
		return scriptBase && member ? this.bindingFromSymbol(member, scriptBase.range) : undefined;
	}

	/** Class behind an `extends` reference: an inner class, a script or a `class_name`. */
	private classFromReference(file: IndexedFile, offset: number, reference: string): IndexedSymbol | undefined {
		const normalized = reference.replace(/^["']|["']$/g, "");
		if (normalized.startsWith("res://") || normalized.endsWith(".gd")) {
			const uri = this.files.findByPathSuffix(normalized);
			const baseFile = uri ? this.files.get(uri) : undefined;
			return baseFile?.symbols.find((symbol) => symbol.kind === "class_name");
		}
		return this.classCandidate(file, offset, normalized) ?? this.globalClassCandidate(normalized);
	}

	/** The `class_name` script this file extends, when it extends one. */
	private scriptBaseClass(file: IndexedFile): IndexedSymbol | undefined {
		const declaration = file.ast.declarations.find((item) => item.kind === "extends");
		if (!declaration || declaration.kind !== "extends") return undefined;
		return this.classFromReference(file, file.ast.range.start.offset, declaration.name);
	}

	private bindingFromSymbol(symbol: IndexedSymbol, scopeRange: SourceRange): Binding | undefined {
		const kind = bindingKind(symbol);
		if (!kind) return undefined;
		return {
			// The same id the scope builder assigned, so references and rename match.
			id: `${symbol.uri}:${symbol.nameOffset ?? symbol.range.start.offset}`,
			name: symbol.name,
			kind,
			uri: symbol.uri,
			declarationRange: symbol.range,
			nameOffset: symbol.nameOffset ?? symbol.range.start.offset,
			scopeRange,
			containerName: symbol.containerName,
			type: symbol.type,
			returnType: symbol.returnType,
		};
	}
}
