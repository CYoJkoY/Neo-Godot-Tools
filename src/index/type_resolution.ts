import {
	GDScriptConstant,
	GDScriptDeclaration,
	GDScriptFunction,
	GDScriptToken,
	GDScriptVariable,
} from "../analyzer/index.js";
import { Binding, BindingIndex } from "./bindings.js";
import { collectControlFlowAssignments } from "./control_flow.js";
import { ChainLink, dotBefore, memberAccessDot, parseChainEndingAt, startsStatement } from "./expression.js";
import { FileIndex } from "./file_index.js";
import { IndexedSymbol } from "./symbol.js";
import { SymbolIndex } from "./symbol_index.js";
import { tokensFor } from "./token_cache.js";

export interface ResolvedType {
	name: string;
	uri?: string;
	symbol?: IndexedSymbol;
	builtin: boolean;
}

const BUILTIN_TYPES = new Set([
	"bool",
	"int",
	"float",
	"String",
	"StringName",
	"NodePath",
	"Node",
	"Node2D",
	"Node3D",
	"Control",
	"Object",
	"RefCounted",
	"Resource",
	"Array",
	"Dictionary",
	"Callable",
	"Signal",
	"Variant",
	"Vector2",
	"Vector2i",
	"Vector3",
	"Vector3i",
	"Vector4",
	"Vector4i",
	"Color",
	"Rect2",
	"Rect2i",
	"Transform2D",
	"Transform3D",
	"Basis",
	"Quaternion",
	"Plane",
	"AABB",
	"RID",
	"PackedByteArray",
	"PackedInt32Array",
	"PackedInt64Array",
	"PackedFloat32Array",
	"PackedFloat64Array",
	"PackedStringArray",
	"PackedVector2Array",
	"PackedVector3Array",
	"PackedVector4Array",
	"PackedColorArray",
]);
const CONSTRUCTOR_TYPES = new Set([
	"StringName",
	"NodePath",
	"Vector2",
	"Vector2i",
	"Vector3",
	"Vector3i",
	"Vector4",
	"Vector4i",
	"Color",
	"Rect2",
	"Rect2i",
	"Transform2D",
	"Transform3D",
	"Basis",
	"Quaternion",
	"Plane",
	"AABB",
	"RID",
	"Array",
	"Dictionary",
	"Callable",
]);

type LocalStatement =
	| { kind: "return"; expression: string; expressionOffset: number }
	| { kind: "assignment"; name: string; expression?: string; expressionOffset?: number; offset: number };

function findDeclaration(
	file: ReturnType<FileIndex["get"]>,
	name: string,
): GDScriptVariable | GDScriptConstant | undefined {
	if (!file) return undefined;
	// Pre-order walk: a nested declaration of an earlier class wins over a later
	// top-level one, which is what GDScript name lookup does.
	const search = (declarations: GDScriptDeclaration[]): GDScriptVariable | GDScriptConstant | undefined =>
		declarations.reduce<GDScriptVariable | GDScriptConstant | undefined>((found, declaration) => {
			if (found) return found;
			if ((declaration.kind === "variable" || declaration.kind === "constant") && declaration.name === name)
				return declaration;
			return declaration.kind === "class" ? search(declaration.declarations) : undefined;
		}, undefined);
	return search(file.ast.declarations);
}

function findScriptClassName(file: ReturnType<FileIndex["get"]>): string | undefined {
	if (!file) return undefined;
	const declaration = file.ast.declarations.find((item) => item.kind === "class_name");
	return declaration?.kind === "class_name" ? declaration.name : undefined;
}

function stripComments(expression: string): string {
	return expression
		.replace(/\s+#.*$/, "")
		.replace(/\s*\.\s*/g, ".")
		.trim();
}
function literalType(expression: string): string | undefined {
	const value = stripComments(expression);
	if (/^(?:true|false)$/.test(value)) return "bool";
	if (/^[-+]?\d+$/.test(value)) return "int";
	if (/^[-+]?(?:\d+\.\d*|\.\d+)(?:[eE][-+]?\d+)?$/.test(value)) return "float";
	if (/^(?:"(?:[^"\\]|\\.)*"|'(?:[^'\\]|\\.)*')$/.test(value)) return "String";
	if (value === "null") return "Variant";
	if (value.startsWith("[") && value.endsWith("]")) return "Array";
	if (value.startsWith("{") && value.endsWith("}")) return "Dictionary";
	if (/^(?:func|lambda)\b/.test(value)) return "Callable";
	return undefined;
}
function topLevelCall(expression: string): { name: string } | undefined {
	const match = expression.match(/^([A-Za-z_]\w*)\s*\(.*\)$/s);
	return match ? { name: match[1] } : undefined;
}
function findFunctions(declarations: GDScriptDeclaration[], name: string): GDScriptFunction[] {
	return declarations.flatMap((declaration) => {
		const own = declaration.kind === "function" && declaration.name === name ? [declaration] : [];
		return declaration.kind === "class" ? [...own, ...findFunctions(declaration.declarations, name)] : own;
	});
}
function findFunctionAt(declarations: GDScriptDeclaration[], offset: number): GDScriptFunction | undefined {
	return declarations.reduce<GDScriptFunction | undefined>((found, declaration) => {
		if (found) return found;
		if (declaration.kind === "function" && declaration.range.start.offset === offset) return declaration;
		return declaration.kind === "class" ? findFunctionAt(declaration.declarations, offset) : undefined;
	}, undefined);
}
function findContainingFunction(declarations: GDScriptDeclaration[], offset: number): GDScriptFunction | undefined {
	const contains = (declaration: GDScriptDeclaration): declaration is GDScriptFunction =>
		declaration.kind === "function" &&
		Boolean(declaration.bodyRange) &&
		declaration.bodyRange!.start.offset <= offset &&
		offset <= declaration.bodyRange!.end.offset;
	return declarations.reduce<GDScriptFunction | undefined>((found, declaration) => {
		if (found) return found;
		if (contains(declaration)) return declaration;
		return declaration.kind === "class" ? findContainingFunction(declaration.declarations, offset) : undefined;
	}, undefined);
}
function splitConditional(expression: string): [string, string] | undefined {
	const match = expression.match(/^(.*?)\s+if\s+.*?\s+else\s+(.*?)$/s);
	return match ? [match[1].trim(), match[2].trim()] : undefined;
}
function tokenText(tokens: GDScriptToken[]): string {
	return tokens
		.map((token) => token.value)
		.join(" ")
		.trim();
}
/** Appends `value` to the list under `key`, creating the list on first use. */
function appendToGroup<K, V>(map: Map<K, V[]>, key: K, value: V): void {
	const entries = map.get(key);
	if (entries) {
		entries.push(value);
		return;
	}
	map.set(key, [value]);
}

/** Index of the `=` assigning to the name at `nameIndex`, or `tokens.length`. */
function equalsIndex(tokens: GDScriptToken[], nameIndex: number): number {
	if (tokens[nameIndex + 1]?.value !== ":") return nameIndex + 1;
	const found = tokens.findIndex((token, index) => index > nameIndex + 1 && token.value === "=");
	return found === -1 ? tokens.length : found;
}

function parseStatement(tokens: GDScriptToken[]): LocalStatement | undefined {
	if (!tokens.length) return undefined;
	if (tokens[0].value === "return") {
		const expressionTokens = tokens.slice(1);
		return expressionTokens.length
			? { kind: "return", expression: tokenText(expressionTokens), expressionOffset: expressionTokens[0].start }
			: undefined;
	}
	const nameIndex = tokens[0].value === "var" || tokens[0].value === "const" ? 1 : 0;
	const name = tokens[nameIndex];
	if (!name || name.kind !== "identifier") return undefined;
	const equals = equalsIndex(tokens, nameIndex);
	const isInferredAssignment = tokens[equals]?.value === ":=";
	if (!isInferredAssignment && tokens[equals]?.value !== "=") return undefined;
	const expressionTokens = tokens.slice(equals + 1);
	return {
		kind: "assignment",
		name: name.value,
		expression: expressionTokens.length ? tokenText(expressionTokens) : undefined,
		expressionOffset: expressionTokens[0]?.start,
		offset: name.start,
	};
}
function collectBodyStatements(
	tokens: readonly GDScriptToken[],
	bodyRange: GDScriptFunction["bodyRange"],
): LocalStatement[] {
	if (!bodyRange) return [];
	// Tokens are ordered, so filtering to the body span is the cursor walk the
	// old accumulator did, and grouping by line keeps one statement per line.
	const lines = new Map<number, GDScriptToken[]>();
	tokens
		.filter(
			(token) =>
				token.kind !== "eof" &&
				token.kind !== "newline" &&
				token.start >= bodyRange.start.offset &&
				token.end <= bodyRange.end.offset,
		)
		.map((token) => appendToGroup(lines, token.line, token));
	return [...lines.values()]
		.map((lineTokens) => parseStatement(lineTokens))
		.filter((statement): statement is LocalStatement => statement !== undefined);
}

/** `own` first, then inherited members whose names are not declared yet. */
function mergeMembers(own: readonly IndexedSymbol[], inherited: readonly IndexedSymbol[]): IndexedSymbol[] {
	const names = new Set(own.map((symbol) => symbol.name));
	const merged = [...own];
	inherited.map((symbol) => {
		if (names.has(symbol.name)) return;
		names.add(symbol.name);
		merged.push(symbol);
	});
	return merged;
}

/** Deletes every entry whose key/value matches; the map is the only state to touch. */
function deleteMatching<K, V>(map: Map<K, V>, matches: (key: K, value: V) => boolean): void {
	[...map.entries()].filter(([key, value]) => matches(key, value)).map(([key]) => map.delete(key));
}

function normalizeScriptReference(value: string): string {
	const trimmed = value.trim();
	const unquoted =
		(trimmed.startsWith('"') && trimmed.endsWith('"')) || (trimmed.startsWith("'") && trimmed.endsWith("'"))
			? trimmed.slice(1, -1)
			: trimmed;
	return unquoted.replace(/\\/g, "/");
}

export interface TypeResolutionIndex {
	resolveName(name: string): ResolvedType | undefined;
	resolveBinding(binding: Binding, offset?: number): ResolvedType | undefined;
	resolveReceiver(uri: string, offset: number, name: string): ResolvedType | undefined;
	getMembers(type: ResolvedType): IndexedSymbol[];
	getMember(type: ResolvedType, name: string): IndexedSymbol | undefined;
	resolveMemberReturnType(type: ResolvedType, member: IndexedSymbol): ResolvedType | undefined;
	resolveContainingClass(uri: string, offset: number): ResolvedType | undefined;
	hasMemberAccessAt(uri: string, offset: number): boolean;
	hasReceiverBeforeDot(uri: string, offset: number): boolean;
	resolveReceiverExpression(uri: string, offset: number): ResolvedType | undefined;
	resolveReceiverBeforeDot(uri: string, offset: number): ResolvedType | undefined;
	resolveExpressionAt(uri: string, endOffset: number): ResolvedType | undefined;
	resolveTypeReference(reference: string): ResolvedType | undefined;
	getClassMembers(uri: string, classSymbol: IndexedSymbol): IndexedSymbol[];
	resolveClassBase(uri: string, classSymbol: IndexedSymbol): ResolvedType | undefined;
	invalidate(uris: Iterable<string>): void;
	clear(): void;
}

export function createTypeResolutionIndex(
	files: FileIndex,
	symbols: SymbolIndex,
	bindings: BindingIndex,
): TypeResolutionIndex {
	const nameCache = new Map<string, { signature: string; value: ResolvedType | null }>();

	const memberCache = new Map<string, { signature: string; members: IndexedSymbol[] }>();

	const statementCache = new Map<string, { fingerprint: string; statements: LocalStatement[] }>();

	const resolveName = (name: string): ResolvedType | undefined => {
		const normalized = name.trim().replace(/^const\s+/, "");
		// `Outer.Inner` / `A.B.C`: a type reached through members of another type.
		if (normalized.includes(".")) return resolveQualifiedName(normalized);
		if (BUILTIN_TYPES.has(normalized)) return { name: normalized, builtin: true };
		const matches = symbols
			.find(normalized)
			.filter(
				(symbol) =>
					symbol.kind === "class_name" ||
					symbol.kind === "class" ||
					(symbol.kind === "enum" && !symbol.containerName),
			);
		const signature = matches
			.map((symbol) => `${symbol.uri}:${symbol.range.start.offset}:${symbol.range.end.offset}`)
			.join("|");
		const cached = nameCache.get(normalized);
		if (cached && cached.signature === signature) return cached.value ?? undefined;
		if (matches.length !== 1) {
			nameCache.set(normalized, { signature, value: null });
			return undefined;
		}
		const result = {
			name: normalized,
			uri: matches[0].uri,
			symbol: matches[0],
			builtin: false,
		} satisfies ResolvedType;
		nameCache.set(normalized, { signature, value: result });
		return result;
	};

	const resolveBinding = (
		binding: Binding,
		offset = binding.declarationRange.start.offset,
	): ResolvedType | undefined => {
		if (binding.kind === "enum") return resolveEnumBinding(binding);
		if (binding.type) return resolveTypeReference(binding.type);
		if (binding.kind === "function")
			return binding.returnType
				? resolveTypeReference(binding.returnType)
				: resolveFunctionReturnType(binding.uri, binding.name, new Set<string>());
		return resolveInitializerType(binding.uri, binding.name, offset, new Set<string>());
	};

	const resolveReceiver = (uri: string, offset: number, name: string): ResolvedType | undefined => {
		if (name === "self") {
			// Inside an inner class `self` is an instance of that class, not of the
			// script: `self.run()` must find `Worker.run`, not a top-level `run`.
			const containing = resolveContainingClass(uri, offset);
			if (containing) return containing;
			return { name: "self", uri, builtin: false };
		}
		if (name === "super") {
			const containing = resolveContainingClass(uri, offset);
			if (containing?.symbol) return resolveClassBase(uri, containing.symbol);
			const file = files.get(uri);
			return file ? resolveExtends(file.ast.declarations) : undefined;
		}
		const binding = bindings.getBinding(uri, offset, name);
		if (binding) {
			const type = resolveBinding(binding, offset);
			if (type) return type;
		}
		// `Worker.run()` and `Worker.new()`: the receiver is a class (or helper
		// type such as an enum) rather than a variable.
		const named = resolveName(name);
		if (named) return named;
		return resolveInitializerType(uri, name, offset, new Set<string>());
	};

	const getMembers = (type: ResolvedType): IndexedSymbol[] => {
		if (!type.uri) return [];
		if (type.symbol?.kind === "enum") return enumMembers(type.symbol);
		if (type.symbol?.kind === "class") return getClassMembers(type.uri, type.symbol);
		const signature = memberSignature(type.uri, new Set<string>());
		const cached = memberCache.get(type.uri);
		if (cached && cached.signature === signature) return cached.members;
		const members = collectMembers(type.uri, new Set<string>());
		memberCache.set(type.uri, { signature, members });
		return members;
	};

	const getMember = (type: ResolvedType, name: string): IndexedSymbol | undefined => {
		const members = getMembers(type).filter((symbol) => symbol.name === name);
		if (members.length === 1) return members[0];
		// Ambiguity across nested scopes must not hide the member: prefer the
		// declaration that belongs to the resolved class itself.
		if (type.symbol?.kind === "class") {
			const own = members.filter((symbol) => belongsToClass(symbol, type.symbol!));
			if (own.length === 1) return own[0];
		}
		return undefined;
	};

	const resolveMemberReturnType = (type: ResolvedType, member: IndexedSymbol): ResolvedType | undefined => {
		// The value of `EnumName.Member` is the enum itself.
		if (member.kind === "enum_member")
			return type.name === member.containerName ? type : (resolveEnumMemberType(member) ?? type);
		// Nested classes and named enums are types, not values with a declared type.
		if (member.kind === "class" || member.kind === "class_name" || member.kind === "enum") {
			return { name: member.name, uri: member.uri, symbol: member, builtin: false };
		}
		if (member.returnType) return resolveTypeReference(member.returnType);
		if (member.type) return resolveTypeReference(member.type);
		if (member.kind !== "function") return undefined;
		// Resolve the declaration the symbol points at, not the first function
		// with that name: two inner classes may both define `run()`.
		return resolveFunctionReturnTypeForSymbol(member, new Set<string>());
	};

	/** Innermost `class` declaration containing `offset`, if any. */
	const resolveContainingClass = (uri: string, offset: number): ResolvedType | undefined => {
		const file = files.get(uri);
		if (!file) return undefined;
		// Single pass with no intermediate array: this runs for every `self` and
		// member receiver lookup.
		const innermost = file.symbols.reduce<IndexedSymbol | undefined>((best, symbol) => {
			if (symbol.kind !== "class") return best;
			if (symbol.range.start.offset > offset || symbol.range.end.offset < offset) return best;
			return !best || symbol.range.start.offset > best.range.start.offset ? symbol : best;
		}, undefined);
		return innermost ? { name: innermost.name, uri, symbol: innermost, builtin: false } : undefined;
	};

	/**
	 * Type of the expression in front of the `.` that precedes `offset`.
	 *
	 * `offset` is the offset of the member name being resolved, which makes this
	 * the entry point for every `receiver.member` lookup: `self.run()`,
	 * `Worker.new().run()`, `get_player().health`, `Outer.Inner.mode`.
	 */
	/** True when the identifier at `offset` is accessed through a `.`. */
	const hasMemberAccessAt = (uri: string, offset: number): boolean => {
		return memberAccessDot(lexedTokens(uri), offset) !== undefined;
	};

	/** True when the token immediately before `offset` is a member-access dot. */
	const hasReceiverBeforeDot = (uri: string, offset: number): boolean => {
		return dotBefore(lexedTokens(uri), offset) !== undefined;
	};

	const resolveReceiverExpression = (uri: string, offset: number): ResolvedType | undefined => {
		const tokens = lexedTokens(uri);
		const dot = memberAccessDot(tokens, offset);
		if (dot === undefined) return undefined;
		const receiver = resolveExpressionAt(uri, dot);
		if (receiver) return receiver;
		// A statement starting with `.member` is GDScript shorthand for `self`.
		return startsStatement(tokens, dot) ? resolveReceiver(uri, offset, "self") : undefined;
	};

	/** Receiver type of the `.` directly in front of `offset` (`Worker.`). */
	const resolveReceiverBeforeDot = (uri: string, offset: number): ResolvedType | undefined => {
		const tokens = lexedTokens(uri);
		const dot = dotBefore(tokens, offset);
		if (!dot) return undefined;
		const receiver = resolveExpressionAt(uri, dot.start);
		if (receiver) return receiver;
		return startsStatement(tokens, dot.start) ? resolveReceiver(uri, offset, "self") : undefined;
	};

	/**
	 * Type of the access chain that ends exactly at `endOffset`.
	 *
	 * Used both for member receivers and for initializers such as
	 * `var w := Worker.new()`.
	 */
	const resolveExpressionAt = (uri: string, endOffset: number): ResolvedType | undefined => {
		const file = files.get(uri);
		if (!file) return undefined;
		const chain = parseChainEndingAt(lexedTokens(uri), endOffset);
		if (!chain) return undefined;
		return resolveChain(uri, endOffset, chain);
	};

	/** Lexed tokens of a file, shared through the token cache. */
	const lexedTokens = (uri: string): readonly GDScriptToken[] => {
		const file = files.get(uri);
		return file ? tokensFor(uri, file.source, file.sourceFingerprint) : [];
	};

	/**
	 * Resolves a type reference, including qualified ones (`Outer.Inner`).
	 *
	 * Type annotations, `extends` clauses and member types all funnel through
	 * here so a nested class is addressable wherever GDScript accepts one.
	 */
	const resolveTypeReference = (reference: string): ResolvedType | undefined => {
		const trimmed = reference.trim();
		if (!trimmed) return undefined;
		return resolveName(trimmed);
	};

	/** `A.B`, `A.B.C`: walks the members of `A` until the last name. */
	const resolveQualifiedName = (reference: string): ResolvedType | undefined => {
		const [head, ...members] = reference.split(".").filter(Boolean);
		if (!head || !members.length) return undefined;
		return members.reduce<ResolvedType | undefined>(
			(current, name) => (current ? memberOf(current, name) : undefined),
			resolveName(head),
		);
	};

	/** Member `name` of `type` as a value, or `undefined` when it has no such member. */
	const memberOf = (type: ResolvedType, name: string): ResolvedType | undefined => {
		const member = getMember(type, name);
		return member ? memberType(type, member) : undefined;
	};

	/**
	 * Walks an access chain (`Worker` → `new()` → `run()`) and returns the type
	 * of its result. A link that cannot be resolved ends the walk, which is the
	 * difference between "unknown" and "the wrong symbol".
	 */
	const resolveChain = (uri: string, offset: number, chain: readonly ChainLink[]): ResolvedType | undefined => {
		// One reduce over the caller's array: destructuring `[first, ...rest]`
		// would copy the chain on every expression lookup.
		return chain.reduce<ResolvedType | undefined>(
			(current, link, index) =>
				index === 0 ? resolveChainStart(uri, offset, link) : resolveChainLink(current, link),
			undefined,
		);
	};

	/** First link of a chain: a call resolves its result, anything else a receiver. */
	const resolveChainStart = (uri: string, offset: number, link: ChainLink): ResolvedType | undefined =>
		link.call ? resolveCallResult(uri, offset, link.name) : resolveReceiver(uri, offset, link.name);

	/** One link of a chain: a missing receiver or member ends the walk. */
	const resolveChainLink = (current: ResolvedType | undefined, link: ChainLink): ResolvedType | undefined => {
		if (!current) return undefined;
		// `Type.new(...)` constructs the type itself rather than a member.
		if (link.call && link.name === "new" && isClassLike(current)) return current;
		const member = getMember(current, link.name);
		if (!member) return undefined;
		return link.call ? resolveMemberReturnType(current, member) : memberType(current, member);
	};

	/** Result type of `name(...)`, resolving both functions and constructors. */
	const resolveCallResult = (uri: string, offset: number, name: string): ResolvedType | undefined => {
		const binding = bindings.getBinding(uri, offset, name);
		if (binding) {
			const type = resolveBinding(binding, offset);
			if (type) return type;
		}
		const named = resolveName(name);
		if (named) return named;
		const functions = symbols.find(name).filter((symbol) => symbol.kind === "function");
		if (functions.length !== 1) return undefined;
		const fn = functions[0];
		return fn.returnType
			? resolveTypeReference(fn.returnType)
			: resolveFunctionReturnType(fn.uri, fn.name, new Set<string>());
	};

	const isClassLike = (type: ResolvedType): boolean => {
		return type.symbol?.kind === "class" || type.symbol?.kind === "class_name" || type.builtin;
	};

	/** Value or type carried by a member access (`A.B`, `A.b`, `A.B()`). */
	const memberType = (type: ResolvedType, member: IndexedSymbol): ResolvedType | undefined => {
		if (member.kind === "class" || member.kind === "class_name" || member.kind === "enum") {
			return { name: member.name, uri: member.uri, symbol: member, builtin: false };
		}
		return resolveMemberReturnType(type, member);
	};

	/** Members declared directly on an inner class, plus the inherited ones. */
	const getClassMembers = (uri: string, classSymbol: IndexedSymbol): IndexedSymbol[] => {
		const key = `${uri}#${classSymbol.range.start.offset}`;
		const signature = classMemberSignature(uri, classSymbol, new Set<string>());
		const cached = memberCache.get(key);
		if (cached && cached.signature === signature) return cached.members;
		const members = collectClassMembers(uri, classSymbol, new Set<string>());
		memberCache.set(key, { signature, members });
		return members;
	};

	/** Resolves `class Worker extends Base` for an inner class. */
	const resolveClassBase = (uri: string, classSymbol: IndexedSymbol): ResolvedType | undefined => {
		const file = files.get(uri);
		const reference = classSymbol.extendsName ? normalizeScriptReference(classSymbol.extendsName) : "";
		if (!file || !reference) return undefined;
		if (reference.startsWith("res://") || reference.endsWith(".gd")) return resolveScriptPath(reference);
		const sameFile = file.symbols.filter((symbol) => symbol.kind === "class" && symbol.name === reference);
		if (sameFile.length === 1) return { name: reference, uri, symbol: sameFile[0], builtin: false };
		return resolveName(reference);
	};

	const belongsToClass = (symbol: IndexedSymbol, classSymbol: IndexedSymbol): boolean => {
		if (symbol.containerRange && classSymbol.uri === symbol.uri) {
			return symbol.containerRange.start.offset === classSymbol.range.start.offset;
		}
		return Boolean(symbol.containerName) && symbol.containerName === classSymbol.name;
	};

	const collectClassMembers = (uri: string, classSymbol: IndexedSymbol, visited: Set<string>): IndexedSymbol[] => {
		const key = `${uri}#${classSymbol.range.start.offset}`;
		if (visited.has(key)) return [];
		visited.add(key);
		const file = files.get(uri);
		if (!file) return [];
		// `containerRange` identifies the owner exactly; the name comparison keeps
		// older/partial indexes (or hand-built symbols) working.
		const own = file.symbols.filter(
			(symbol) => symbol.kind !== "class_name" && belongsToClass(symbol, classSymbol),
		);
		const base = resolveClassBase(uri, classSymbol);
		const inherited = base?.uri
			? base.symbol?.kind === "class"
				? collectClassMembers(base.uri, base.symbol, visited)
				: collectMembers(base.uri, visited)
			: [];
		return mergeMembers(own, inherited);
	};

	const classMemberSignature = (uri: string, classSymbol: IndexedSymbol, visited: Set<string>): string => {
		const key = `${uri}#${classSymbol.range.start.offset}`;
		if (visited.has(key)) return `cycle:${key}`;
		visited.add(key);
		const file = files.get(uri);
		if (!file) return `missing:${uri}`;
		const base = resolveClassBase(uri, classSymbol);
		const baseSignature = base?.uri
			? base.symbol?.kind === "class"
				? classMemberSignature(base.uri, base.symbol, visited)
				: memberSignature(base.uri, visited)
			: "";
		return `${key}@${file.sourceFingerprint}[${baseSignature}]`;
	};

	const resolveEnumMemberType = (member: IndexedSymbol): ResolvedType | undefined => {
		if (!member.containerName) return undefined;
		const file = files.get(member.uri);
		const symbol = file?.symbols.find(
			(candidate) => candidate.kind === "enum" && candidate.name === member.containerName,
		);
		return symbol ? { name: symbol.name, uri: member.uri, symbol, builtin: false } : undefined;
	};

	const invalidate = (uris: Iterable<string>): void => {
		const affected = new Set(uris);
		deleteMatching(statementCache, (key) => {
			const marker = key.indexOf(":function:");
			return marker >= 0 && affected.has(key.slice(0, marker));
		});
		deleteMatching(memberCache, (key) => {
			const marker = key.indexOf("#");
			return affected.has(marker >= 0 ? key.slice(0, marker) : key);
		});
		deleteMatching(nameCache, (_name, cached) =>
			cached.value === null ? affected.size > 0 : Boolean(cached.value.uri && affected.has(cached.value.uri)),
		);
	};

	const clear = (): void => {
		nameCache.clear();
		memberCache.clear();
		statementCache.clear();
	};

	/** Resolves the declaration behind an enum binding instead of guessing by name. */
	const resolveEnumBinding = (binding: Binding): ResolvedType | undefined => {
		const symbol = symbols
			.find(binding.name)
			.find(
				(candidate) =>
					candidate.kind === "enum" &&
					candidate.uri === binding.uri &&
					(candidate.nameOffset ?? candidate.range.start.offset) === binding.nameOffset,
			);
		if (symbol) return { name: binding.name, uri: binding.uri, symbol, builtin: false };
		return resolveName(binding.name);
	};

	const enumMembers = (symbol: IndexedSymbol): IndexedSymbol[] => {
		const file = files.get(symbol.uri);
		if (!file) return [];
		return file.symbols.filter(
			(candidate) => candidate.kind === "enum_member" && candidate.containerName === symbol.name,
		);
	};

	const memberSignature = (uri: string, visited: Set<string>): string => {
		if (visited.has(uri)) return `cycle:${uri}`;
		visited.add(uri);
		const file = files.get(uri);
		if (!file) return `missing:${uri}`;
		const base = resolveExtends(file.ast.declarations);
		return `${uri}@${file.apiFingerprint}:${file.sourceFingerprint}[${base?.uri ? memberSignature(base.uri, visited) : ""}]`;
	};

	const collectMembers = (uri: string, visited: Set<string>): IndexedSymbol[] => {
		if (visited.has(uri)) return [];
		visited.add(uri);
		const file = files.get(uri);
		if (!file) return [];
		// `class_name` is the type itself, not one of its members.
		const own = file.symbols.filter((symbol) => !symbol.containerName && symbol.kind !== "class_name");
		const base = resolveExtends(file.ast.declarations);
		return mergeMembers(own, base?.uri ? collectMembers(base.uri, visited) : []);
	};

	const resolveExtends = (declarations: GDScriptDeclaration[]): ResolvedType | undefined => {
		const declaration = declarations.find((item) => item.kind === "extends");
		if (!declaration || declaration.kind !== "extends") return undefined;
		const reference = normalizeScriptReference(declaration.name);
		return reference.startsWith("res://") || reference.endsWith(".gd")
			? resolveScriptPath(reference)
			: resolveName(reference);
	};

	const resolveScriptPath = (value: string): ResolvedType | undefined => {
		const path = normalizeScriptReference(value)
			.replace(/^res:\/\//, "")
			.replace(/^\/+/, "");
		const uri = files.findByPathSuffix(path);
		if (!uri) return undefined;
		const file = files.get(uri);
		const className = findScriptClassName(file);
		const symbol = className ? symbols.find(className).find((item) => item.uri === uri) : undefined;
		return { name: className ?? path.replace(/\.gd$/, ""), uri, symbol, builtin: false };
	};

	const getBodyStatements = (uri: string, fn: GDScriptFunction): LocalStatement[] => {
		const file = files.get(uri);
		if (!file || !fn.bodyRange) return [];
		const key = `${uri}:function:${fn.bodyRange.start.offset}:${fn.bodyRange.end.offset}`;
		const cached = statementCache.get(key);
		if (cached?.fingerprint === file.sourceFingerprint) return cached.statements;
		const statements = collectBodyStatements(tokensFor(uri, file.source, file.sourceFingerprint), fn.bodyRange);
		statementCache.set(key, { fingerprint: file.sourceFingerprint, statements });
		return statements;
	};

	const resolveExpressionType = (
		uri: string,
		expression: string,
		offset: number,
		visited: Set<string>,
	): ResolvedType | undefined => {
		const value = stripComments(expression);
		const literal = literalType(value);
		if (literal) return resolveName(literal) ?? { name: literal, builtin: true };
		const conditional = splitConditional(value);
		if (conditional) {
			const left = resolveExpressionType(uri, conditional[0], offset, visited);
			const right = resolveExpressionType(uri, conditional[1], offset, visited);
			if (left && right && left.name === right.name) return left;
			return undefined;
		}
		const preload = value.match(/^preload\s*\(\s*["']([^"']+\.gd)["']\s*\)\s*\.\s*new\s*\(\s*\)$/);
		if (preload) return resolveScriptPath(preload[1]);
		const load = value.match(/^load\s*\(\s*["']([^"']+)["']\s*\)$/);
		if (load) return { name: "Resource", builtin: true };
		const constructed = value.match(/^([A-Za-z_]\w*)\s*\.\s*new\s*\(.*\)$/s);
		if (constructed) {
			if (CONSTRUCTOR_TYPES.has(constructed[1]))
				return resolveName(constructed[1]) ?? { name: constructed[1], builtin: true };
			const type = resolveName(constructed[1]);
			if (type) return type;
		}
		const memberCall = value.match(/^([A-Za-z_]\w*)\s*\.\s*([A-Za-z_]\w*)\s*\(.*\)$/s);
		if (memberCall) {
			const receiver = resolveReceiver(uri, offset, memberCall[1]);
			if (receiver) {
				const member = getMember(receiver, memberCall[2]);
				if (member) return resolveMemberReturnType(receiver, member);
			}
		}
		const memberAccess = value.match(/^([A-Za-z_]\w*)\s*\.\s*([A-Za-z_]\w*)$/s);
		if (memberAccess) {
			const receiver = resolveReceiver(uri, offset, memberAccess[1]);
			if (receiver) {
				const member = getMember(receiver, memberAccess[2]);
				if (member) return resolveMemberReturnType(receiver, member);
			}
		}
		const call = topLevelCall(value);
		if (call) {
			if (CONSTRUCTOR_TYPES.has(call.name)) return resolveName(call.name) ?? { name: call.name, builtin: true };
			const functions = symbols.find(call.name).filter((symbol) => symbol.kind === "function");
			if (functions.length === 1) {
				const fn = functions[0];
				return fn.returnType
					? resolveTypeReference(fn.returnType)
					: resolveFunctionReturnType(fn.uri, fn.name, visited);
			}
		}
		const binding = bindings.getBinding(uri, offset, value);
		if (binding) return resolveBinding(binding, offset);
		return resolveName(value);
	};

	const resolveInitializerType = (
		uri: string,
		name: string,
		offset: number,
		visited: Set<string>,
	): ResolvedType | undefined => {
		const key = `${uri}:${name}:${offset}`;
		if (visited.has(key)) return undefined;
		visited.add(key);
		const file = files.get(uri);
		if (!file) return undefined;
		const declaration = findDeclaration(file, name);
		if (declaration?.type) return resolveTypeReference(declaration.type);
		if (declaration?.value) {
			const result = resolveExpressionType(uri, declaration.value, declaration.range.start.offset, visited);
			if (result) return result;
		}
		const functionDeclaration = findContainingFunction(file.ast.declarations, offset);
		if (!functionDeclaration) return undefined;
		const controlFlow = collectControlFlowAssignments(file.source, functionDeclaration.bodyRange, name, offset);
		// Relevant control flow with no safe branch assignment is an unknown type.
		if (controlFlow !== undefined)
			return controlFlow.length
				? sharedExpressionType(
						uri,
						controlFlow.map((expression) => ({ expression, offset })),
						visited,
					)
				: undefined;
		const latest = getBodyStatements(uri, functionDeclaration)
			.filter(
				(statement): statement is Extract<LocalStatement, { kind: "assignment" }> =>
					statement.kind === "assignment" && statement.name === name && statement.offset <= offset,
			)
			.at(-1);
		if (!latest?.expression || latest.expressionOffset === undefined) return undefined;
		return resolveExpressionType(uri, latest.expression, latest.expressionOffset, visited);
	};

	/** Type every expression shares, or `undefined` when one is unknown or they disagree. */
	const sharedExpressionType = (
		uri: string,
		expressions: readonly { expression: string; offset: number }[],
		visited: Set<string>,
	): ResolvedType | undefined => {
		const types = expressions
			.map((item) => resolveExpressionType(uri, item.expression, item.offset, new Set(visited)))
			.filter((type): type is ResolvedType => type !== undefined);
		if (types.length !== expressions.length) return undefined;
		return types.every((type) => type.name === types[0].name) ? types[0] : undefined;
	};

	const resolveFunctionReturnTypeForSymbol = (
		member: IndexedSymbol,
		visited: Set<string>,
	): ResolvedType | undefined => {
		const file = files.get(member.uri);
		if (!file) return undefined;
		const declaration = findFunctionAt(file.ast.declarations, member.range.start.offset);
		if (!declaration) return resolveFunctionReturnType(member.uri, member.name, visited);
		if (declaration.returnType) return resolveTypeReference(declaration.returnType);
		const returns = getBodyStatements(member.uri, declaration).filter(
			(statement): statement is Extract<LocalStatement, { kind: "return" }> => statement.kind === "return",
		);
		if (!returns.length) return undefined;
		return sharedExpressionType(
			member.uri,
			returns.map((item) => ({ expression: item.expression, offset: item.expressionOffset })),
			visited,
		);
	};

	const resolveFunctionReturnType = (uri: string, name: string, visited: Set<string>): ResolvedType | undefined => {
		const key = `${uri}:function:${name}`;
		if (visited.has(key)) return undefined;
		visited.add(key);
		const file = files.get(uri);
		if (!file) return undefined;
		const functions = findFunctions(file.ast.declarations, name);
		if (functions.length !== 1) return undefined;
		const fn = functions[0];
		if (fn.returnType) return resolveTypeReference(fn.returnType);
		const returns = getBodyStatements(uri, fn).filter(
			(statement): statement is Extract<LocalStatement, { kind: "return" }> => statement.kind === "return",
		);
		if (!returns.length) return undefined;
		return sharedExpressionType(
			uri,
			returns.map((item) => ({ expression: item.expression, offset: item.expressionOffset })),
			visited,
		);
	};

	return {
		resolveName,
		resolveBinding,
		resolveReceiver,
		getMembers,
		getMember,
		resolveMemberReturnType,
		resolveContainingClass,
		hasMemberAccessAt,
		hasReceiverBeforeDot,
		resolveReceiverExpression,
		resolveReceiverBeforeDot,
		resolveExpressionAt,
		resolveTypeReference,
		getClassMembers,
		resolveClassBase,
		invalidate,
		clear,
	};
}
