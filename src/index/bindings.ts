import { GDScriptDeclaration, GDScriptParameter, GDScriptToken, SourceRange } from "../analyzer/index.js";
import { addToGroup, dropFromGroup } from "./collections.js";
import { ChainLink, parseChainEndingAt, startsStatement } from "./expression.js";
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

/**
 * First token index whose start is at or after `offset`.
 *
 * Range-scoped passes used `tokens.findIndex` over the whole stream, which is
 * linear per call and therefore quadratic per file. Token starts are sorted, so
 * the position is a binary search.
 */
function firstTokenAtOrAfter(tokens: readonly GDScriptToken[], offset: number): number {
	return lowerBound(tokens, 0, tokens.length, offset);
}

function lowerBound(tokens: readonly GDScriptToken[], low: number, high: number, offset: number): number {
	if (low >= high) return low;
	const middle = low + Math.floor((high - low) / 2);
	return tokens[middle].start < offset
		? lowerBound(tokens, middle + 1, high, offset)
		: lowerBound(tokens, low, middle, offset);
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

function addParameters(scope: Scope, parameters: readonly GDScriptParameter[], uri: string): void {
	parameters.map((parameter) =>
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

interface ScopeSource {
	tokens: readonly GDScriptToken[];
	uri: string;
}

interface LocalDeclarationRequest {
	source: ScopeSource;
	body: SourceRange;
	scope: Scope;
	excluded?: readonly SourceRange[];
}

function addLocalDeclarations({ source, body, scope, excluded = [] }: LocalDeclarationRequest): void {
	const { tokens, uri } = source;
	// Only the body is inspected, and the token before it is kept so a declaration
	// on the first body line still sees its `var`/`const` keyword.
	const from = Math.max(0, firstTokenAtOrAfter(tokens, body.start.offset) - 1);
	const to = firstTokenAtOrAfter(tokens, body.end.offset + 1);
	tokens
		.slice(from, to)
		.map((token, offset) => ({ token, index: from + offset }))
		.filter(
			({ token, index }) => {
				const previous = tokens[index - 1];
				return (
					previous !== undefined &&
					token.kind === "identifier" &&
					(previous.value === "var" || previous.value === "const") &&
					previous.line === token.line &&
					token.start >= body.start.offset &&
					token.end <= body.end.offset &&
					!excluded.some((range) => contains(range, token.start))
				);
			},
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

const OPENING_DELIMITERS = new Set(["(", "[", "{"]);
const CLOSING_DELIMITERS = new Set([")", "]", "}"]);

/** Index of the `)` closing the `(` opened at `openIndex`. */
function closingParen(tokens: readonly GDScriptToken[], openIndex: number): number | undefined {
	const nextDepth = (token: GDScriptToken, depth: number): number =>
		token.value === "(" ? depth + 1 : token.value === ")" ? depth - 1 : depth;
	const scan = (index: number, depth: number): number | undefined => {
		const token = tokens[index];
		if (token.kind === "eof") return undefined;
		const depthAfter = nextDepth(token, depth);
		return token.value === ")" && depthAfter === 0 ? index : scan(index + 1, depthAfter);
	};
	return scan(openIndex + 1, 1);
}

/** Colon ending a lambda header, after its optional `-> Type`. */
function lambdaHeaderColon(tokens: readonly GDScriptToken[], start: number): number | undefined {
	const nextDepth = (token: GDScriptToken, depth: number): number =>
		OPENING_DELIMITERS.has(token.value)
			? depth + 1
			: CLOSING_DELIMITERS.has(token.value)
				? depth - 1
				: depth;
	const scan = (index: number, depth: number): number | undefined => {
		const token = tokens[index];
		if (token.kind === "eof" || token.kind === "newline") return undefined;
		if (token.value === ":" && depth === 0) return index;
		return scan(index + 1, nextDepth(token, depth));
	};
	return scan(start, 0);
}

/** Last token of a single-line lambda body starting at `start`. */
function inlineBodyEnd(tokens: readonly GDScriptToken[], start: number): GDScriptToken {
	const first = tokens[start];
	const line = first.line;
	const scan = (index: number, depth: number, last: GDScriptToken): GDScriptToken => {
		const token = tokens[index];
		if (token.kind === "eof" || token.kind === "newline" || token.line !== line) return last;
		if (CLOSING_DELIMITERS.has(token.value) && depth === 0) return last;
		if (token.value === "," && depth === 0) return last;
		const nextDepth = CLOSING_DELIMITERS.has(token.value)
			? depth - 1
			: OPENING_DELIMITERS.has(token.value)
				? depth + 1
				: depth;
		return scan(index + 1, nextDepth, token);
	};
	return scan(start, 0, first);
}

/**
 * Body of the lambda whose header colon is at `colonIndex`: the rest of the
 * header line for an inline lambda, otherwise the indented block after it.
 */
function lambdaBodyRange(
	tokens: readonly GDScriptToken[],
	colonIndex: number,
	parentIndent: number,
): SourceRange | undefined {
	const colon = tokens[colonIndex];
	const cursor = tokens.findIndex((token, index) => index > colonIndex && token.kind !== "newline");
	if (cursor < 0) return undefined;
	const first = tokens[cursor];
	if (!first || first.kind === "eof") return undefined;
	if (first.line === colon.line) return rangeBetweenTokens(first, inlineBodyEnd(tokens, cursor));
	if (first.indent <= parentIndent) return undefined;
	const scan = (index: number, previousLine: number, last: GDScriptToken): GDScriptToken => {
		const token = tokens[index];
		if (!token || token.kind === "eof") return last;
		if (token.kind === "newline") return scan(index + 1, token.line, last);
		if (token.line !== previousLine && token.indent <= parentIndent) return last;
		return scan(index + 1, token.line, token);
	};
	return rangeBetweenTokens(first, scan(cursor, first.line, first));
}

function rangeBetweenTokens(first: GDScriptToken, last: GDScriptToken): SourceRange {
	return { start: tokenRange(first).start, end: tokenRange(last).end };
}

/**
 * Parameters between the parentheses of a lambda header. Only the top-level
 * leading identifier of each comma-separated entry is a parameter name; the
 * rest of the entry is its type or default value.
 */
function lambdaParameters(
	tokens: readonly GDScriptToken[],
	openIndex: number,
	closeIndex: number,
): GDScriptParameter[] {
	const scan = (
		index: number,
		depth: number,
		expectsName: boolean,
		parameters: GDScriptParameter[],
	): GDScriptParameter[] => {
		if (index >= closeIndex) return parameters;
		const token = tokens[index];
		const depthAfter = OPENING_DELIMITERS.has(token.value)
			? depth + 1
			: CLOSING_DELIMITERS.has(token.value)
				? depth - 1
				: depth;
		if (token.value === "," && depthAfter === 0) return scan(index + 1, depthAfter, true, parameters);
		if (!expectsName || depthAfter !== 0 || token.kind !== "identifier")
			return scan(index + 1, depthAfter, expectsName, parameters);
		return scan(
			index + 1,
			depthAfter,
			false,
			parameters.concat({ name: token.value, range: tokenRange(token) }),
		);
	};
	return scan(openIndex + 1, 0, true, []);
}

interface LambdaScope {
	range: SourceRange;
	body?: SourceRange;
	parameters: GDScriptParameter[];
}

/** Lambda scope read from `func(`, or `undefined` when the header is malformed. */
function readLambdaScope(tokens: readonly GDScriptToken[], funcIndex: number): LambdaScope | undefined {
	const open = tokens[funcIndex + 1];
	if (open?.value !== "(") return undefined;
	const close = closingParen(tokens, funcIndex + 1);
	if (close === undefined) return undefined;
	const colon = lambdaHeaderColon(tokens, close + 1);
	if (colon === undefined) return undefined;
	const body = lambdaBodyRange(tokens, colon, tokens[funcIndex].indent);
	const end = body?.end ?? tokenRange(tokens[colon]).end;
	return {
		range: { start: tokenRange(tokens[funcIndex]).start, end },
		body,
		parameters: lambdaParameters(tokens, funcIndex + 1, close),
	};
}

/**
 * Immediate lambda scopes in `[startOffset, endOffset]`. A lambda's body is
 * skipped so nested lambdas are returned from that lambda's own scan only.
 */
function lambdasIn(tokens: readonly GDScriptToken[], startOffset: number, endOffset: number): LambdaScope[] {
	const first = firstTokenAtOrAfter(tokens, startOffset);
	if (first >= tokens.length) return [];
	const scan = (index: number, found: LambdaScope[]): LambdaScope[] => {
		const token = tokens[index];
		if (!token || token.start > endOffset) return found;
		const lambda = token.kind === "identifier" && token.value === "func" ? readLambdaScope(tokens, index) : undefined;
		if (!lambda) return scan(index + 1, found);
		return scan(firstTokenAtOrAfter(tokens, lambda.range.end.offset), [...found, lambda]);
	};
	return scan(first, []);
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
	const source = { tokens, uri };
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

	/**
	 * Adds a lambda scope and recurses into the lambdas nested in its body.
	 *
	 * The parser only models declared functions, so lambdas are read from the
	 * token stream. Their scopes are children of the enclosing scope, which
	 * keeps outer parameters and locals visible inside the lambda.
	 */
	const addLambda = (lambda: LambdaScope, parent: Scope): void => {
		const lambdaScope = createScope(lambda.range, "function", parent);
		addParameters(lambdaScope, lambda.parameters, uri);
		if (!lambda.body) return;
		const nested = lambdasIn(tokens, lambda.body.start.offset, lambda.body.end.offset);
		addLocalDeclarations({
			source,
			body: lambda.body,
			scope: lambdaScope,
			excluded: nested.flatMap((child) => (child.body ? [child.body] : [])),
		});
		nested.map((child) => addLambda(child, lambdaScope));
	};

	/** Adds the immediate lambdas in `range` as children of `parent`. */
	const addLambdas = (range: SourceRange, parent: Scope): void => {
		lambdasIn(tokens, range.start.offset, range.end.offset).map((lambda) => addLambda(lambda, parent));
	};

	const visitDeclaration = (declaration: GDScriptDeclaration, parent: Scope): void => {
		if (declaration.kind === "class") {
			const classScope = createScope(declaration.range, "class", parent);
			addSymbols(classScope, (symbol) => symbol.containerName === declaration.name, declaration.name);
			visit(declaration.declarations, classScope);
			return;
		}
		if (declaration.kind !== "function") {
			addLambdas(declaration.range, parent);
			return;
		}
		const functionScope = createScope(declaration.range, "function", parent);
		addParameters(functionScope, declaration.parameters, uri);
		if (declaration.bodyRange) {
			const nested = lambdasIn(
				tokens,
				declaration.bodyRange.start.offset,
				declaration.bodyRange.end.offset,
			);
			addLocalDeclarations({
				source,
				body: declaration.bodyRange,
				scope: functionScope,
				excluded: nested.flatMap((lambda) => (lambda.body ? [lambda.body] : [])),
			});
		}
		addLambdas(declaration.range, functionScope);
	};
	const visit = (declarations: GDScriptDeclaration[], parent: Scope): void => {
		declarations.map((declaration) => visitDeclaration(declaration, parent));
	};

	addSymbols(root, (symbol) => !symbol.containerName);
	visit(file.ast.declarations, root);
	return root;
}
/**
 * Innermost scope containing `offset`.
 *
 * Scopes are visited in declaration order, so a scope's `children` are sorted by
 * start offset. The lookup binary-searches the one child that can contain the
 * offset instead of scanning siblings at every level.
 */
function findInnermostScope(scope: Scope, offset: number): Scope {
	const child = childContaining(scope.children, offset);
	return child ? findInnermostScope(child, offset) : scope;
}

function childContaining(children: readonly Scope[], offset: number): Scope | undefined {
	const index = lastScopeStartingAtOrBefore(children, offset, 0, children.length);
	const candidate = index < 0 ? undefined : children[index];
	return candidate && contains(candidate.range, offset) ? candidate : undefined;
}

/** Index of the last scope whose start offset is at or before `offset`. */
function lastScopeStartingAtOrBefore(scopes: readonly Scope[], offset: number, low: number, high: number): number {
	if (low >= high) return low - 1;
	const middle = low + Math.floor((high - low) / 2);
	return scopes[middle].range.start.offset <= offset
		? lastScopeStartingAtOrBefore(scopes, offset, middle + 1, high)
		: lastScopeStartingAtOrBefore(scopes, offset, low, middle);
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
	/**
	 * Binding declared in a scope of `uri`. Unlike `getBinding`, this never falls
	 * back to a workspace-wide unique name, so a foreign declaration cannot
	 * answer a query about this file.
	 */
	getScopedBinding(uri: string, offset: number, name: string): Binding | undefined;
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
		return resolveBinding(uri, offset, name, { allowFunctionScopes: true, allowWorkspaceFallback: true });
	};

	/**
	 * Resolves a member access such as `self.health`. Function scopes are skipped
	 * so a parameter or local variable that shadows a script member does not
	 * capture the reference.
	 */

	const getMemberBinding = (uri: string, offset: number, name: string): Binding | undefined => {
		return resolveBinding(uri, offset, name, { allowFunctionScopes: false, allowWorkspaceFallback: true });
	};

	const getScopedBinding = (uri: string, offset: number, name: string): Binding | undefined => {
		return resolveBinding(uri, offset, name, { allowFunctionScopes: true, allowWorkspaceFallback: false });
	};

	interface ResolutionOptions {
		allowFunctionScopes: boolean;
		allowWorkspaceFallback: boolean;
	}

	const resolveBinding = (
		uri: string,
		offset: number,
		name: string,
		options: ResolutionOptions,
	): Binding | undefined => {
		const root = scopes.get(uri);
		if (!root) return undefined;
		const scope = scopeChain(root, offset)
			.filter((candidate) => options.allowFunctionScopes || candidate.kind !== "function")
			.map((candidate) => findBinding(candidate, name, offset))
			.find((binding) => binding !== undefined);
		if (scope) return scope;
		if (!options.allowWorkspaceFallback) return undefined;
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
		// One filter per binding: dropping each reference separately re-filtered
		// the bucket of every identifier in the file, which is quadratic for the
		// repeated names a large script is full of.
		const offsetsByBinding = references.reduce<Map<string, Set<number>>>((groups, reference) => {
			const offsets = groups.get(reference.bindingId) ?? new Set<number>();
			return groups.set(reference.bindingId, offsets.add(reference.range.start.offset));
		}, new Map());
		[...offsetsByBinding].map(([bindingId, offsets]) =>
			dropFromGroup(
				referencesByBinding,
				bindingId,
				(entry) => entry.uri === uri && offsets.has(entry.range.start.offset),
			),
		);
		referencesByUri.delete(uri);
		const own = byUri.get(uri) ?? [];
		const idsByName = own.reduce<Map<string, Set<string>>>((groups, binding) => {
			const ids = groups.get(binding.name) ?? new Set<string>();
			return groups.set(binding.name, ids.add(binding.id));
		}, new Map());
		[...idsByName].map(([name, ids]) => dropFromGroup(byName, name, (entry) => ids.has(entry.id)));
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
		const dot = tokens[index - 1];
		if (dot?.kind === "punctuation" && dot.value === "." && startsStatement(tokens, dot.start)) {
			// A statement starting with `.member` is GDScript shorthand for
			// `super.member`, so references and rename bind to the parent method.
			return resolveSuperMember(uri, token.start, token.value);
		}
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
		const containing = containingClass(file, offset);
		// Inside an inner class `super` is that class's own base, not the script's.
		const declaration = file.ast.declarations.find((item) => item.kind === "extends");
		const reference = containing
			? containing.extendsName
			: declaration?.kind === "extends"
				? declaration.name
				: undefined;
		if (!reference) return undefined;
		const base = classFromReference(file, offset, reference);
		if (base?.kind === "class") {
			const member = findClassMember(base.uri, base, name, new Set<string>());
			return member ? bindingFromSymbol(member, base.range) : undefined;
		}
		// The base may be a script without a `class_name`, which only its path
		// identifies.
		const baseUri = base?.uri ?? baseScriptUri(reference);
		const baseFile = baseUri ? files.get(baseUri) : undefined;
		const member = baseUri ? resolveScriptMember(baseUri, name, new Set<string>()) : undefined;
		return member && baseFile ? bindingFromSymbol(member, baseFile.ast.range) : undefined;
	};

	/** Top-level member of the script at `uri`, following its `extends` chain. */

	const resolveScriptMember = (uri: string, name: string, visited: Set<string>): IndexedSymbol | undefined => {
		if (visited.has(uri)) return undefined;
		visited.add(uri);
		const file = files.get(uri);
		if (!file) return undefined;
		const own = file.symbols.find(
			(symbol) =>
				symbol.name === name &&
				symbol.kind !== "class_name" &&
				!symbol.containerName &&
				!symbol.containerRange,
		);
		if (own) return own;
		const declaration = file.ast.declarations.find((item) => item.kind === "extends");
		if (!declaration || declaration.kind !== "extends") return undefined;
		const baseUri = baseScriptUri(declaration.name);
		return baseUri ? resolveScriptMember(baseUri, name, visited) : undefined;
	};

	/** Indexed script behind an `extends` reference, including one without `class_name`. */

	const baseScriptUri = (reference: string): string | undefined => {
		const normalized = reference.replace(/^["']|["']$/g, "");
		if (normalized.startsWith("res://") || normalized.endsWith(".gd"))
			return files.findByPathSuffix(normalized);
		return globalClassCandidate(normalized)?.uri;
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
		getScopedBinding,
		getVisibleBindings,
		findReferences,
		remove,
		clear,
	};
}
