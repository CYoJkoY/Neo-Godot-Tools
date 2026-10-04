import { GDScriptDeclaration, GDScriptFunction, GDScriptToken, SourceRange } from "../analyzer/index.js";
import { addToGroup, dropFromGroup } from "./collections.js";
import { ChainLink, parseChainEndingAt } from "./expression.js";
import { FileIndex } from "./file_index.js";
import { IndexedFile, IndexedSymbol } from "./symbol.js";
import { tokensFor } from "./token_cache.js";

export type BindingKind =
	| "parameter"
	| "local"
	| "member"
	| "function"
	| "class"
	| "constant"
	| "class_name"
	| "signal"
	| "enum"
	| "enum_member";

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
		case "variable":
			return "member";
		case "function":
			return "function";
		case "class":
			return "class";
		case "constant":
			return "constant";
		case "class_name":
			return "class_name";
		case "signal":
			return "signal";
		case "enum":
			return "enum";
		case "enum_member":
			return "enum_member";
		default:
			return undefined;
	}
}

/** Type after `:`: `Outer.Inner`, `Array[int]`, `Callable`. */
function readTypeName(tokens: readonly GDScriptToken[], start: number): string | undefined {
	return scanTypeName(tokens, start, "") || undefined;
}

/** `Ident(.Ident)*` from `index`, stopping at the first token that breaks it. */
function scanTypeName(tokens: readonly GDScriptToken[], index: number, parts: string): string {
	const token = tokens[index];
	if (!token) return parts;
	if (token.kind === "identifier" && (!parts || parts.endsWith(".")))
		return scanTypeName(tokens, index + 1, `${parts}${token.value}`);
	if (token.value === "." && parts && !parts.endsWith(".")) return scanTypeName(tokens, index + 1, `${parts}.`);
	return parts;
}

function addBinding(scope: Scope, binding: Binding): void {
	const entries = scope.bindings.get(binding.name) ?? [];
	entries.push(binding);
	scope.bindings.set(binding.name, entries);
}

function addParameters(scope: Scope, fn: GDScriptFunction, uri: string): void {
	fn.parameters.map((parameter) =>
		addBinding(scope, {
			id: `${uri}:${parameter.range.start.offset}`,
			name: parameter.name,
			kind: "parameter",
			uri,
			declarationRange: parameter.range,
			nameOffset: parameter.range.start.offset,
			scopeRange: scope.range,
			type: parameter.type,
		}),
	);
}

function addLocalDeclarations(tokens: readonly GDScriptToken[], fn: GDScriptFunction, scope: Scope, uri: string): void {
	if (!fn.bodyRange) return;
	const body = fn.bodyRange;
	tokens
		.map((token, index) => ({ token, index, previous: tokens[index - 1] }))
		.filter(
			({ token, previous }) =>
				previous !== undefined &&
				token.kind === "identifier" &&
				(previous.value === "var" || previous.value === "const") &&
				previous.line === token.line &&
				token.start >= body.start.offset &&
				token.end <= body.end.offset,
		)
		.map(({ token, index }) =>
			addBinding(scope, {
				id: `${uri}:${token.start}`,
				name: token.value,
				kind: "local",
				uri,
				declarationRange: tokenRange(token),
				nameOffset: token.start,
				scopeRange: scope.range,
				type: tokens[index + 1]?.value === ":" ? readTypeName(tokens, index + 2) : undefined,
			}),
		);
}

function createScope(range: SourceRange, kind: ScopeKind, parent?: Scope): Scope {
	const scope: Scope = { range, kind, parent, children: [], bindings: new Map() };
	parent?.children.push(scope);
	return scope;
}

/** Binding record for an indexed symbol declared inside `scopeRange`. */
function symbolBinding(
	symbol: IndexedSymbol,
	kind: BindingKind,
	uri: string,
	scopeRange: SourceRange,
	containerName?: string,
): Binding {
	return {
		id: `${uri}:${symbol.nameOffset ?? symbol.range.start.offset}`,
		name: symbol.name,
		kind,
		uri,
		declarationRange: symbol.range,
		nameOffset: symbol.nameOffset ?? symbol.range.start.offset,
		scopeRange,
		containerName,
		type: symbol.type,
		returnType: symbol.returnType,
	};
}

function buildScopes(file: IndexedFile, uri: string): Scope {
	const tokens = tokensFor(uri, file.source, file.sourceFingerprint);
	const root = createScope(file.ast.range, "root");

	/** Adds the bindings of every symbol with a binding kind that `matches`. */
	const addSymbols = (scope: Scope, matches: (symbol: IndexedSymbol) => boolean, containerName?: string): void => {
		file.symbols
			.filter(matches)
			.map((symbol) => ({ symbol, kind: bindingKind(symbol) }))
			.filter((entry): entry is { symbol: IndexedSymbol; kind: BindingKind } => entry.kind !== undefined)
			.map((entry) =>
				addBinding(scope, symbolBinding(entry.symbol, entry.kind, uri, scope.range, containerName)),
			);
	};

	const visitDeclaration = (declaration: GDScriptDeclaration, parent: Scope): void => {
		if (declaration.kind === "class") {
			const classScope = createScope(declaration.range, "class", parent);
			addSymbols(classScope, (symbol) => symbol.containerName === declaration.name, declaration.name);
			visit(declaration.declarations, classScope);
			return;
		}
		if (declaration.kind !== "function") return;
		const functionScope = createScope(declaration.range, "function", parent);
		addParameters(functionScope, declaration, uri);
		addLocalDeclarations(tokens, declaration, functionScope, uri);
	};
	const visit = (declarations: GDScriptDeclaration[], parent: Scope): void => {
		declarations.map((declaration) => visitDeclaration(declaration, parent));
	};

	addSymbols(root, (symbol) => !symbol.containerName);
	visit(file.ast.declarations, root);
	return root;
}

function findInnermostScope(scope: Scope, offset: number): Scope {
	const child = scope.children.find((candidate) => contains(candidate.range, offset));
	return child ? findInnermostScope(child, offset) : scope;
}

/** Innermost scope at `offset` first, then its ancestors. */
function scopeChain(root: Scope, offset: number): Scope[] {
	return ancestors(findInnermostScope(root, offset));
}

/** `scope` followed by every enclosing scope, innermost first. */
function ancestors(scope: Scope): Scope[] {
	return scope.parent ? [scope, ...ancestors(scope.parent)] : [scope];
}

function findBinding(scope: Scope, name: string, offset: number): Binding | undefined {
	const entries = scope.bindings.get(name) ?? [];
	const visible = entries.filter((binding) => contains(binding.scopeRange, offset));
	if (!visible.length) return undefined;
	const declarationsBefore = visible.filter((binding) => binding.declarationRange.start.offset <= offset);
	return declarationsBefore[declarationsBefore.length - 1] ?? visible[0];
}

const nonReferenceIdentifiers = new Set([
	"and",
	"as",
	"await",
	"breakpoint",
	"break",
	"class_name",
	"class",
	"const",
	"continue",
	"elif",
	"else",
	"enum",
	"extends",
	"false",
	"for",
	"func",
	"if",
	"in",
	"is",
	"match",
	"not",
	"null",
	"or",
	"pass",
	"preload",
	"return",
	"self",
	"signal",
	"static",
	"super",
	"true",
	"var",
	"void",
	"while",
	"when",
]);

export interface BindingIndex {
	update(uri: string): void;
	getBinding(uri: string, offset: number, name: string): Binding | undefined;
	getMemberBinding(uri: string, offset: number, name: string): Binding | undefined;
	getVisibleBindings(uri: string, offset: number): Binding[];
	findReferences(bindingId: string): BoundReference[];
	remove(uri: string): void;
	clear(): void;
}

export function createBindingIndex(files: FileIndex): BindingIndex {
	const byName = new Map<string, Binding[]>();

	const byUri = new Map<string, Binding[]>();

	const referencesByUri = new Map<string, BoundReference[]>();

	const referencesByBinding = new Map<string, BoundReference[]>();

	const scopes = new Map<string, Scope>();

	const update = (uri: string): void => {
		remove(uri);
		const file = files.get(uri);
		if (!file) return;
		const root = buildScopes(file, uri);
		scopes.set(uri, root);
		const bindings = allBindings(root);
		byUri.set(uri, bindings);
		bindings.map((binding) => addToGroup(byName, binding.name, binding));
		const references = resolveReferences(tokensFor(uri, file.source, file.sourceFingerprint), uri);
		referencesByUri.set(uri, references);
		references.map((reference) => addToGroup(referencesByBinding, reference.bindingId, reference));
	};

	const getBinding = (uri: string, offset: number, name: string): Binding | undefined => {
		return resolveBinding(uri, offset, name, true);
	};

	/**
	 * Resolves a member access such as `self.health`. Function scopes are skipped
	 * so a parameter or local variable that shadows a script member does not
	 * capture the reference.
	 */

	const getMemberBinding = (uri: string, offset: number, name: string): Binding | undefined => {
		return resolveBinding(uri, offset, name, false);
	};

	const resolveBinding = (
		uri: string,
		offset: number,
		name: string,
		allowFunctionScopes: boolean,
	): Binding | undefined => {
		const root = scopes.get(uri);
		if (!root) return undefined;
		const scope = scopeChain(root, offset)
			.filter((candidate) => allowFunctionScopes || candidate.kind !== "function")
			.map((candidate) => findBinding(candidate, name, offset))
			.find((binding) => binding !== undefined);
		if (scope) return scope;
		const global = byName.get(name) ?? [];
		return global.length === 1 ? global[0] : undefined;
	};

	/**
	 * Bindings visible at `offset`, ordered by completion priority: innermost
	 * scope first, then enclosing scopes, and inside a scope by declaration order.
	 */

	const getVisibleBindings = (uri: string, offset: number): Binding[] => {
		const root = scopes.get(uri);
		if (!root) return [];
		const names = new Set<string>();
		const visibleIn = (scope: Scope): Binding[] => {
			const visible = [...scope.bindings.keys()]
				.filter((name) => !names.has(name))
				.map((name) => findBinding(scope, name, offset))
				.filter((binding): binding is Binding => binding !== undefined)
				.sort((left, right) => left.declarationRange.start.offset - right.declarationRange.start.offset);
			visible.map((binding) => names.add(binding.name));
			return scope.parent ? [...visible, ...visibleIn(scope.parent)] : visible;
		};
		return visibleIn(findInnermostScope(root, offset));
	};

	const findReferences = (bindingId: string): BoundReference[] => {
		// Indexed by binding id: scanning every reference of every file here made
		// rename/find-references quadratic on large workspaces.
		return [...(referencesByBinding.get(bindingId) ?? [])];
	};

	const remove = (uri: string): void => {
		scopes.delete(uri);
		const references = referencesByUri.get(uri) ?? [];
		references.map((reference) =>
			dropFromGroup(
				referencesByBinding,
				reference.bindingId,
				(entry) => entry.uri === uri && entry.range.start.offset === reference.range.start.offset,
			),
		);
		referencesByUri.delete(uri);
		const own = byUri.get(uri) ?? [];
		own.map((binding) => dropFromGroup(byName, binding.name, (entry) => entry.id === binding.id));
		byUri.delete(uri);
	};

	const clear = (): void => {
		byName.clear();
		byUri.clear();
		referencesByUri.clear();
		referencesByBinding.clear();
		scopes.clear();
	};

	const allBindings = (scope: Scope): Binding[] => {
		return [...scope.bindings.values()].flat().concat(...scope.children.map((child) => allBindings(child)));
	};

	const resolveReferences = (tokens: readonly GDScriptToken[], uri: string): BoundReference[] =>
		tokens
			.map((token, index) => ({ token, index }))
			.filter(({ token }) => token.kind === "identifier" && !nonReferenceIdentifiers.has(token.value))
			.map(({ token, index }) => referenceFor(tokens, uri, token, index))
			.filter((reference): reference is BoundReference => reference !== undefined);

	/** Reference for one identifier, or `undefined` when it binds to nothing. */
	const referenceFor = (
		tokens: readonly GDScriptToken[],
		uri: string,
		token: GDScriptToken,
		index: number,
	): BoundReference | undefined => {
		if (tokens[index - 1]?.value !== ".")
			return boundReference(getBinding(uri, token.start, token.value), token, uri);
		return boundReference(memberAfterDot(tokens, uri, token, index), token, uri);
	};

	const boundReference = (
		binding: Binding | undefined,
		token: GDScriptToken,
		uri: string,
	): BoundReference | undefined =>
		binding ? { bindingId: binding.id, name: token.value, uri, range: tokenRange(token) } : undefined;

	/** Member addressed by `receiver.token`, resolved through the receiver chain. */
	const memberAfterDot = (
		tokens: readonly GDScriptToken[],
		uri: string,
		token: GDScriptToken,
		index: number,
	): Binding | undefined => {
		const previousPrevious = tokens[index - 2]?.value;
		if (previousPrevious === "self") {
			// `self.member` always addresses a class member, never a local variable
			// or parameter with the same name. Inside an inner class the member may
			// be inherited (`self.ping()` → `Base.ping`), which the plain scope
			// lookup cannot see.
			const scopeMember = getMemberBinding(uri, token.start, token.value);
			return scopeMember ?? chainMember(uri, token, parseChainEndingAt(tokens, tokens[index - 1].start));
		}
		if (previousPrevious === "super") return resolveSuperMember(uri, token.start, token.value);
		// `Worker.run()`, `A.Inner.run()`, `Worker.new().run()` and `make().run()`
		// all bind to the member of the class behind the receiver expression, so
		// find-references and rename cover nested classes instead of falling back
		// to a name guess.
		return chainMember(uri, token, parseChainEndingAt(tokens, tokens[index - 1].start));
	};

	const chainMember = (
		uri: string,
		token: GDScriptToken,
		chain: readonly ChainLink[] | undefined,
	): Binding | undefined => (chain ? resolveChainMember(uri, token.start, chain, token.value) : undefined);

	/**
	 * The member addressed through `receiver.member`, where the receiver is a
	 * chain of accesses: a class name (`Worker.run()`), a nested class
	 * (`A.B.run()`), a constructed instance (`Worker.new().run()`) or a call
	 * result (`make().run()`).
	 */

	const resolveChainMember = (
		uri: string,
		offset: number,
		chain: readonly ChainLink[],
		memberName: string,
	): Binding | undefined => {
		const owner = chainClass(uri, offset, chain);
		if (!owner) return undefined;
		const member = findClassMember(owner.uri, owner, memberName, new Set<string>());
		return member ? bindingFromSymbol(member, owner.range) : undefined;
	};

	/**
	 * Class declaration a receiver chain belongs to, or `undefined` when any
	 * link of the chain has an unknown type.
	 */

	const chainClass = (uri: string, offset: number, chain: readonly ChainLink[]): IndexedSymbol | undefined => {
		const file = files.get(uri);
		if (!file || !chain.length) return undefined;
		return chain.reduce<IndexedSymbol | undefined>(
			(current, link, index) =>
				index === 0 ? chainStart(file, uri, offset, link) : chainStep(file, current, link, offset),
			undefined,
		);
	};

	/** First link of a chain: a class name, an inferred variable type, or `self`. */
	const chainStart = (file: IndexedFile, uri: string, offset: number, link: ChainLink): IndexedSymbol | undefined => {
		const named = namedClass(file, link.name, offset);
		if (named || link.call) return named;
		const inferred = inferReceiverTypeName(uri, offset, link.name);
		const inferredClass = inferred ? namedClass(file, inferred, offset) : undefined;
		if (inferredClass) return inferredClass;
		return link.name === "self" ? containingClass(file, offset) : undefined;
	};

	/** One link after the first: `Type.new(...)` keeps the type, members move to theirs. */
	const chainStep = (
		file: IndexedFile,
		current: IndexedSymbol | undefined,
		link: ChainLink,
		offset: number,
	): IndexedSymbol | undefined => {
		if (!current) return undefined;
		if (link.call && link.name === "new") return current;
		const member = findClassMember(current.uri, current, link.name, new Set<string>());
		if (!member) return undefined;
		const typeName = link.call ? member.returnType : (member.type ?? member.name);
		if (!typeName) return undefined;
		const normalized = typeName.replace(/^([A-Za-z_]\w*).*$/, "$1");
		return namedClass(file, normalized, offset) ?? classCandidateOf(current.uri, normalized, offset);
	};

	const classCandidateOf = (uri: string, name: string, offset: number): IndexedSymbol | undefined => {
		const file = files.get(uri);
		return file ? namedClass(file, name, offset) : undefined;
	};

	const namedClass = (file: IndexedFile, name: string, offset: number): IndexedSymbol | undefined => {
		return classCandidate(file, offset, name) ?? globalClassCandidate(name);
	};

	/** Innermost class declaration containing `offset`. */

	const containingClass = (file: IndexedFile, offset: number): IndexedSymbol | undefined =>
		file.symbols.reduce<IndexedSymbol | undefined>((innermost, symbol) => {
			if (symbol.kind !== "class") return innermost;
			if (symbol.range.start.offset > offset || symbol.range.end.offset < offset) return innermost;
			return !innermost || symbol.range.start.offset > innermost.range.start.offset ? symbol : innermost;
		}, undefined);

	/** A class declaration named `name` visible at `offset`, preferring the innermost. */

	const classCandidate = (file: IndexedFile, offset: number, name: string): IndexedSymbol | undefined => {
		const candidates = file.symbols.filter((symbol) => symbol.kind === "class" && symbol.name === name);
		if (!candidates.length) return undefined;
		const enclosing = candidates
			.filter((symbol) => symbol.range.start.offset <= offset && offset <= symbol.range.end.offset)
			.sort((left, right) => right.range.start.offset - left.range.start.offset);
		return (
			enclosing[0] ??
			candidates.find((symbol) => !symbol.containerName) ??
			(candidates.length === 1 ? candidates[0] : undefined)
		);
	};

	const globalClassCandidate = (name: string): IndexedSymbol | undefined => {
		const declarations = (byName.get(name) ?? []).filter((binding) => binding.kind === "class_name");
		if (declarations.length !== 1) return undefined;
		const file = files.get(declarations[0].uri);
		return file?.symbols.find((symbol) => symbol.kind === "class_name" && symbol.name === name);
	};

	/** Infers the class a variable holds from its explicit type or `X.new()`. */

	const inferReceiverTypeName = (uri: string, offset: number, receiverName: string): string | undefined => {
		const binding = getBinding(uri, offset, receiverName) ?? getMemberBinding(uri, offset, receiverName);
		if (!binding) return undefined;
		const explicit = binding.type?.match(/^([A-Za-z_]\w*(?:\.[A-Za-z_]\w*)*)/)?.[1];
		if (explicit && explicit !== "Array" && explicit !== "Dictionary") return explicit;
		const file = files.get(uri);
		if (!file) return undefined;
		const lineEnd = file.source.indexOf("\n", binding.declarationRange.start.offset);
		const declaration = file.source.slice(binding.declarationRange.start.offset, lineEnd < 0 ? undefined : lineEnd);
		const constructed = declaration.match(/=\s*(?:preload\s*\([^)]*\)\s*\.\s*)?([A-Za-z_]\w*)\s*\.\s*new\s*\(/);
		if (constructed) return constructed[1];
		const typed = declaration.match(/^[^=]*:\s*([A-Za-z_]\w*)/);
		return typed?.[1];
	};

	/** Looks up `name` on a class, following its `extends` chain. */

	const findClassMember = (
		uri: string,
		classSymbol: IndexedSymbol,
		name: string,
		visited: Set<string>,
	): IndexedSymbol | undefined => {
		const key = `${uri}#${classSymbol.range.start.offset}`;
		if (visited.has(key)) return undefined;
		visited.add(key);
		const file = files.get(uri);
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
			const base = classCandidate(file, classSymbol.range.start.offset, reference);
			const baseMember = base ? findClassMember(uri, base, name, visited) : undefined;
			if (baseMember) return baseMember;
			if (reference.startsWith("res://") || reference.endsWith(".gd")) {
				const baseUri = files.findByPathSuffix(reference);
				const baseFile = baseUri ? files.get(baseUri) : undefined;
				const baseClass = baseFile?.symbols.find((symbol) => symbol.kind === "class_name");
				if (baseUri && baseClass) return findClassMember(baseUri, baseClass, name, visited);
			}
		}
		if (classSymbol.kind === "class_name") return undefined;
		// A script-level class may extend another script (`extends Base`).
		const scriptBase = file.symbols.find((symbol) => symbol.kind === "class_name");
		if (!scriptBase || scriptBase === classSymbol) return undefined;
		const extendsDeclaration = file.ast.declarations.find((declaration) => declaration.kind === "extends");
		const scriptReference =
			extendsDeclaration?.kind === "extends" ? extendsDeclaration.name.replace(/^["']|["']$/g, "") : undefined;
		if (!scriptReference || (!scriptReference.startsWith("res://") && !scriptReference.endsWith(".gd")))
			return undefined;
		const baseUri = files.findByPathSuffix(scriptReference);
		const baseFile = baseUri ? files.get(baseUri) : undefined;
		const baseClass = baseFile?.symbols.find((symbol) => symbol.kind === "class_name");
		return baseUri && baseClass ? findClassMember(baseUri, baseClass, name, visited) : undefined;
	};

	/** The base-class member addressed by `super.name`. */

	const resolveSuperMember = (uri: string, offset: number, name: string): Binding | undefined => {
		const file = files.get(uri);
		if (!file) return undefined;
		// Inside an inner class `super` is that class's own base, not the script's.
		const containing = containingClass(file, offset);
		if (containing?.extendsName) {
			const base = classFromReference(file, offset, containing.extendsName);
			const member = base ? findClassMember(base.uri, base, name, new Set<string>()) : undefined;
			if (base && member) return bindingFromSymbol(member, base.range);
		}
		const scriptBase = scriptBaseClass(file);
		const member = scriptBase ? findClassMember(scriptBase.uri, scriptBase, name, new Set<string>()) : undefined;
		return scriptBase && member ? bindingFromSymbol(member, scriptBase.range) : undefined;
	};

	/** Class behind an `extends` reference: an inner class, a script or a `class_name`. */

	const classFromReference = (file: IndexedFile, offset: number, reference: string): IndexedSymbol | undefined => {
		const normalized = reference.replace(/^["']|["']$/g, "");
		if (normalized.startsWith("res://") || normalized.endsWith(".gd")) {
			const uri = files.findByPathSuffix(normalized);
			const baseFile = uri ? files.get(uri) : undefined;
			return baseFile?.symbols.find((symbol) => symbol.kind === "class_name");
		}
		return classCandidate(file, offset, normalized) ?? globalClassCandidate(normalized);
	};

	/** The `class_name` script this file extends, when it extends one. */

	const scriptBaseClass = (file: IndexedFile): IndexedSymbol | undefined => {
		const declaration = file.ast.declarations.find((item) => item.kind === "extends");
		if (!declaration || declaration.kind !== "extends") return undefined;
		return classFromReference(file, file.ast.range.start.offset, declaration.name);
	};

	const bindingFromSymbol = (symbol: IndexedSymbol, scopeRange: SourceRange): Binding | undefined => {
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
	};

	return {
		update,
		getBinding,
		getMemberBinding,
		getVisibleBindings,
		findReferences,
		remove,
		clear,
	};
}
