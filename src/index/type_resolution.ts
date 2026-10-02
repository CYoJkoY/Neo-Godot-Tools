import { GDScriptConstant, GDScriptDeclaration, GDScriptFunction, GDScriptToken, GDScriptVariable, lexGDScript } from "../analyzer/index.js";
import { Binding, BindingIndex } from "./bindings.js";
import { collectControlFlowAssignments } from "./control_flow.js";
import { FileIndex } from "./file_index.js";
import { IndexedSymbol } from "./symbol.js";
import { SymbolIndex } from "./symbol_index.js";

export interface ResolvedType { name: string; uri?: string; symbol?: IndexedSymbol; builtin: boolean; }

const BUILTIN_TYPES = new Set([
	"bool", "int", "float", "String", "StringName", "NodePath", "Node", "Node2D", "Node3D", "Control", "Object",
	"RefCounted", "Resource", "Array", "Dictionary", "Callable", "Signal", "Variant", "Vector2", "Vector2i",
	"Vector3", "Vector3i", "Vector4", "Vector4i", "Color", "Rect2", "Rect2i", "Transform2D", "Transform3D", "Basis",
	"Quaternion", "Plane", "AABB", "RID", "PackedByteArray", "PackedInt32Array", "PackedInt64Array", "PackedFloat32Array",
	"PackedFloat64Array", "PackedStringArray", "PackedVector2Array", "PackedVector3Array", "PackedVector4Array", "PackedColorArray",
]);
const CONSTRUCTOR_TYPES = new Set([
	"StringName", "NodePath", "Vector2", "Vector2i", "Vector3", "Vector3i", "Vector4", "Vector4i", "Color", "Rect2", "Rect2i",
	"Transform2D", "Transform3D", "Basis", "Quaternion", "Plane", "AABB", "RID", "Array", "Dictionary", "Callable",
]);

type LocalStatement =
	| { kind: "return"; expression: string; expressionOffset: number }
	| { kind: "assignment"; name: string; expression?: string; expressionOffset?: number; offset: number };

function findDeclaration(file: ReturnType<FileIndex["get"]>, name: string): GDScriptVariable | GDScriptConstant | undefined {
	if (!file) return undefined;
	const visit = (declarations: GDScriptDeclaration[]): GDScriptVariable | GDScriptConstant | undefined => {
		for (const declaration of declarations) {
			if ((declaration.kind === "variable" || declaration.kind === "constant") && declaration.name === name) return declaration;
			if (declaration.kind === "class") { const nested = visit(declaration.declarations); if (nested) return nested; }
		}
		return undefined;
	};
	return visit(file.ast.declarations);
}

function findScriptClassName(file: ReturnType<FileIndex["get"]>): string | undefined {
	if (!file) return undefined;
	const declaration = file.ast.declarations.find((item) => item.kind === "class_name");
	return declaration?.kind === "class_name" ? declaration.name : undefined;
}

function stripComments(expression: string): string {
	return expression.replace(/\s+#.*$/, "").replace(/\s*\.\s*/g, ".").trim();
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
	const result: GDScriptFunction[] = [];
	for (const declaration of declarations) {
		if (declaration.kind === "function" && declaration.name === name) result.push(declaration);
		if (declaration.kind === "class") result.push(...findFunctions(declaration.declarations, name));
	}
	return result;
}
function findFunctionAt(declarations: GDScriptDeclaration[], offset: number): GDScriptFunction | undefined {
	for (const declaration of declarations) {
		if (declaration.kind === "function" && declaration.range.start.offset === offset) return declaration;
		if (declaration.kind === "class") {
			const nested = findFunctionAt(declaration.declarations, offset);
			if (nested) return nested;
		}
	}
	return undefined;
}
function findContainingFunction(declarations: GDScriptDeclaration[], offset: number): GDScriptFunction | undefined {
	for (const declaration of declarations) {
		if (declaration.kind === "function" && declaration.bodyRange && declaration.bodyRange.start.offset <= offset && offset <= declaration.bodyRange.end.offset) return declaration;
		if (declaration.kind === "class") { const nested = findContainingFunction(declaration.declarations, offset); if (nested) return nested; }
	}
	return undefined;
}
function splitConditional(expression: string): [string, string] | undefined {
	const match = expression.match(/^(.*?)\s+if\s+.*?\s+else\s+(.*?)$/s);
	return match ? [match[1].trim(), match[2].trim()] : undefined;
}
function tokenText(tokens: GDScriptToken[]): string { return tokens.map((token) => token.value).join(" ").trim(); }
function parseStatement(tokens: GDScriptToken[]): LocalStatement | undefined {
	if (!tokens.length) return undefined;
	if (tokens[0].value === "return") {
		const expressionTokens = tokens.slice(1);
		return expressionTokens.length ? { kind: "return", expression: tokenText(expressionTokens), expressionOffset: expressionTokens[0].start } : undefined;
	}
	const nameIndex = tokens[0].value === "var" || tokens[0].value === "const" ? 1 : 0;
	const name = tokens[nameIndex];
	if (!name || name.kind !== "identifier") return undefined;
	let equalsIndex = nameIndex + 1;
	if (tokens[equalsIndex]?.value === ":") {
		equalsIndex++;
		while (equalsIndex < tokens.length && tokens[equalsIndex].value !== "=") equalsIndex++;
	}
	const isInferredAssignment = tokens[equalsIndex]?.value === ":=";
	if (!isInferredAssignment && tokens[equalsIndex]?.value !== "=") return undefined;
	const expressionTokens = tokens.slice(equalsIndex + 1);
	return { kind: "assignment", name: name.value, expression: expressionTokens.length ? tokenText(expressionTokens) : undefined, expressionOffset: expressionTokens[0]?.start, offset: name.start };
}
function collectBodyStatements(source: string, bodyRange: GDScriptFunction["bodyRange"]): LocalStatement[] {
	if (!bodyRange) return [];
	const tokens = lexGDScript(source);
	const result: LocalStatement[] = [];
	let lineTokens: GDScriptToken[] = [];
	let currentLine = -1;
	const flush = () => { const statement = parseStatement(lineTokens); if (statement) result.push(statement); lineTokens = []; };
	for (const token of tokens) {
		if (token.kind === "eof") break;
		if (token.start < bodyRange.start.offset) continue;
		if (token.end > bodyRange.end.offset) break;
		if (token.kind === "newline") { flush(); currentLine = -1; continue; }
		if (currentLine !== -1 && token.line !== currentLine) flush();
		currentLine = token.line;
		lineTokens.push(token);
	}
	flush();
	return result;
}

function normalizeScriptReference(value: string): string {
	const trimmed = value.trim();
	const unquoted = ((trimmed.startsWith("\"") && trimmed.endsWith("\"")) || (trimmed.startsWith("'") && trimmed.endsWith("'")))
		? trimmed.slice(1, -1)
		: trimmed;
	return unquoted.replace(/\\/g, "/");
}

export class TypeResolutionIndex {
	private readonly nameCache = new Map<string, { signature: string; value: ResolvedType | null }>();
	private readonly memberCache = new Map<string, { signature: string; members: IndexedSymbol[] }>();
	private readonly statementCache = new Map<string, { fingerprint: string; statements: LocalStatement[] }>();
	constructor(private readonly files: FileIndex, private readonly symbols: SymbolIndex, private readonly bindings: BindingIndex) {}

	resolveName(name: string): ResolvedType | undefined {
		const normalized = name.trim().replace(/^const\s+/, "");
		if (BUILTIN_TYPES.has(normalized)) return { name: normalized, builtin: true };
		const matches = this.symbols.find(normalized).filter((symbol) => symbol.kind === "class_name" || symbol.kind === "class" || (symbol.kind === "enum" && !symbol.containerName));
		const signature = matches.map((symbol) => `${symbol.uri}:${symbol.range.start.offset}:${symbol.range.end.offset}`).join("|");
		const cached = this.nameCache.get(normalized);
		if (cached && cached.signature === signature) return cached.value ?? undefined;
		if (matches.length !== 1) { this.nameCache.set(normalized, { signature, value: null }); return undefined; }
		const result = { name: normalized, uri: matches[0].uri, symbol: matches[0], builtin: false } satisfies ResolvedType;
		this.nameCache.set(normalized, { signature, value: result });
		return result;
	}
	resolveBinding(binding: Binding, offset = binding.declarationRange.start.offset): ResolvedType | undefined {
		if (binding.kind === "enum") return this.resolveEnumBinding(binding);
		if (binding.type) return this.resolveName(binding.type);
		if (binding.kind === "function") return binding.returnType ? this.resolveName(binding.returnType) : this.resolveFunctionReturnType(binding.uri, binding.name, new Set<string>());
		return this.resolveInitializerType(binding.uri, binding.name, offset, new Set<string>());
	}
	resolveReceiver(uri: string, offset: number, name: string): ResolvedType | undefined {
		if (name === "self") {
			// Inside an inner class `self` is an instance of that class, not of the
			// script: `self.run()` must find `Worker.run`, not a top-level `run`.
			const containing = this.resolveContainingClass(uri, offset);
			if (containing) return containing;
			return { name: "self", uri, builtin: false };
		}
		if (name === "super") {
			const containing = this.resolveContainingClass(uri, offset);
			if (containing?.symbol) return this.resolveClassBase(uri, containing.symbol);
			const file = this.files.get(uri);
			return file ? this.resolveExtends(file.ast.declarations) : undefined;
		}
		const binding = this.bindings.getBinding(uri, offset, name);
		if (binding) { const type = this.resolveBinding(binding, offset); if (type) return type; }
		// `Worker.run()` and `Worker.new()`: the receiver is a class (or helper
		// type such as an enum) rather than a variable.
		const named = this.resolveName(name);
		if (named) return named;
		return this.resolveInitializerType(uri, name, offset, new Set<string>());
	}
	getMembers(type: ResolvedType): IndexedSymbol[] {
		if (!type.uri) return [];
		if (type.symbol?.kind === "enum") return this.enumMembers(type.symbol);
		if (type.symbol?.kind === "class") return this.getClassMembers(type.uri, type.symbol);
		const signature = this.memberSignature(type.uri, new Set<string>());
		const cached = this.memberCache.get(type.uri);
		if (cached && cached.signature === signature) return cached.members;
		const members = this.collectMembers(type.uri, new Set<string>());
		this.memberCache.set(type.uri, { signature, members });
		return members;
	}
	getMember(type: ResolvedType, name: string): IndexedSymbol | undefined {
		const members = this.getMembers(type).filter((symbol) => symbol.name === name);
		if (members.length === 1) return members[0];
		// Ambiguity across nested scopes must not hide the member: prefer the
		// declaration that belongs to the resolved class itself.
		if (type.symbol?.kind === "class") {
			const own = members.filter((symbol) => this.belongsToClass(symbol, type.symbol!));
			if (own.length === 1) return own[0];
		}
		return undefined;
	}
	resolveMemberReturnType(type: ResolvedType, member: IndexedSymbol): ResolvedType | undefined {
		// The value of `EnumName.Member` is the enum itself.
		if (member.kind === "enum_member") return type.name === member.containerName ? type : this.resolveEnumMemberType(member) ?? type;
		if (member.returnType) return this.resolveName(member.returnType);
		if (member.type) return this.resolveName(member.type);
		if (member.kind !== "function") return undefined;
		// Resolve the declaration the symbol points at, not the first function
		// with that name: two inner classes may both define `run()`.
		return this.resolveFunctionReturnTypeForSymbol(member, new Set<string>());
	}
	/** Innermost `class` declaration containing `offset`, if any. */
	resolveContainingClass(uri: string, offset: number): ResolvedType | undefined {
		const file = this.files.get(uri);
		if (!file) return undefined;
		let best: IndexedSymbol | undefined;
		for (const symbol of file.symbols) {
			if (symbol.kind !== "class") continue;
			if (symbol.range.start.offset > offset || symbol.range.end.offset < offset) continue;
			if (!best || symbol.range.start.offset > best.range.start.offset) best = symbol;
		}
		return best ? { name: best.name, uri, symbol: best, builtin: false } : undefined;
	}
	/** Members declared directly on an inner class, plus the inherited ones. */
	getClassMembers(uri: string, classSymbol: IndexedSymbol): IndexedSymbol[] {
		const key = `${uri}#${classSymbol.range.start.offset}`;
		const signature = this.classMemberSignature(uri, classSymbol, new Set<string>());
		const cached = this.memberCache.get(key);
		if (cached && cached.signature === signature) return cached.members;
		const members = this.collectClassMembers(uri, classSymbol, new Set<string>());
		this.memberCache.set(key, { signature, members });
		return members;
	}
	/** Resolves `class Worker extends Base` for an inner class. */
	resolveClassBase(uri: string, classSymbol: IndexedSymbol): ResolvedType | undefined {
		const file = this.files.get(uri);
		const reference = classSymbol.extendsName ? normalizeScriptReference(classSymbol.extendsName) : "";
		if (!file || !reference) return undefined;
		if (reference.startsWith("res://") || reference.endsWith(".gd")) return this.resolveScriptPath(reference);
		const sameFile = file.symbols.filter((symbol) => symbol.kind === "class" && symbol.name === reference);
		if (sameFile.length === 1) return { name: reference, uri, symbol: sameFile[0], builtin: false };
		return this.resolveName(reference);
	}
	private belongsToClass(symbol: IndexedSymbol, classSymbol: IndexedSymbol): boolean {
		if (symbol.containerRange && classSymbol.uri === symbol.uri) {
			return symbol.containerRange.start.offset === classSymbol.range.start.offset;
		}
		return Boolean(symbol.containerName) && symbol.containerName === classSymbol.name;
	}
	private collectClassMembers(uri: string, classSymbol: IndexedSymbol, visited: Set<string>): IndexedSymbol[] {
		const key = `${uri}#${classSymbol.range.start.offset}`;
		if (visited.has(key)) return [];
		visited.add(key);
		const file = this.files.get(uri);
		if (!file) return [];
		// `containerRange` identifies the owner exactly; the name comparison keeps
		// older/partial indexes (or hand-built symbols) working.
		const own = file.symbols.filter((symbol) => symbol.kind !== "class_name" && this.belongsToClass(symbol, classSymbol));
		const base = this.resolveClassBase(uri, classSymbol);
		const inherited = base?.uri
			? base.symbol?.kind === "class"
				? this.collectClassMembers(base.uri, base.symbol, visited)
				: this.collectMembers(base.uri, visited)
			: [];
		const result = [...own];
		for (const symbol of inherited) if (!result.some((candidate) => candidate.name === symbol.name)) result.push(symbol);
		return result;
	}
	private classMemberSignature(uri: string, classSymbol: IndexedSymbol, visited: Set<string>): string {
		const key = `${uri}#${classSymbol.range.start.offset}`;
		if (visited.has(key)) return `cycle:${key}`;
		visited.add(key);
		const file = this.files.get(uri);
		if (!file) return `missing:${uri}`;
		const base = this.resolveClassBase(uri, classSymbol);
		const baseSignature = base?.uri
			? base.symbol?.kind === "class"
				? this.classMemberSignature(base.uri, base.symbol, visited)
				: this.memberSignature(base.uri, visited)
			: "";
		return `${key}@${file.sourceFingerprint}[${baseSignature}]`;
	}
	private resolveEnumMemberType(member: IndexedSymbol): ResolvedType | undefined {
		if (!member.containerName) return undefined;
		const file = this.files.get(member.uri);
		const symbol = file?.symbols.find((candidate) => candidate.kind === "enum" && candidate.name === member.containerName);
		return symbol ? { name: symbol.name, uri: member.uri, symbol, builtin: false } : undefined;
	}
	invalidate(uris: Iterable<string>): void {
		const affected = new Set(uris);
		for (const key of this.statementCache.keys()) { const marker = key.indexOf(":function:"); if (marker >= 0 && affected.has(key.slice(0, marker))) this.statementCache.delete(key); }
		for (const [key] of this.memberCache) {
			const marker = key.indexOf("#");
			const keyUri = marker >= 0 ? key.slice(0, marker) : key;
			if (affected.has(keyUri)) this.memberCache.delete(key);
		}
		for (const [name, cached] of this.nameCache) if (cached.value?.uri && affected.has(cached.value.uri)) this.nameCache.delete(name);
		if (affected.size) for (const [name, cached] of this.nameCache) if (cached.value === null) this.nameCache.delete(name);
	}
	clear(): void { this.nameCache.clear(); this.memberCache.clear(); this.statementCache.clear(); }
	/** Resolves the declaration behind an enum binding instead of guessing by name. */
	private resolveEnumBinding(binding: Binding): ResolvedType | undefined {
		const symbol = this.symbols.find(binding.name).find((candidate) =>
			candidate.kind === "enum" &&
			candidate.uri === binding.uri &&
			candidate.range.start.offset === binding.declarationRange.start.offset,
		);
		if (symbol) return { name: binding.name, uri: binding.uri, symbol, builtin: false };
		return this.resolveName(binding.name);
	}

	private enumMembers(symbol: IndexedSymbol): IndexedSymbol[] {
		const file = this.files.get(symbol.uri);
		if (!file) return [];
		return file.symbols.filter((candidate) => candidate.kind === "enum_member" && candidate.containerName === symbol.name);
	}

	private memberSignature(uri: string, visited: Set<string>): string {
		if (visited.has(uri)) return `cycle:${uri}`;
		visited.add(uri);
		const file = this.files.get(uri);
		if (!file) return `missing:${uri}`;
		const base = this.resolveExtends(file.ast.declarations);
		return `${uri}@${file.apiFingerprint}:${file.sourceFingerprint}[${base?.uri ? this.memberSignature(base.uri, visited) : ""}]`;
	}
	private collectMembers(uri: string, visited: Set<string>): IndexedSymbol[] {
		if (visited.has(uri)) return [];
		visited.add(uri);
		const file = this.files.get(uri);
		if (!file) return [];
		// `class_name` is the type itself, not one of its members.
		const own = file.symbols.filter((symbol) => !symbol.containerName && symbol.kind !== "class_name");
		const base = this.resolveExtends(file.ast.declarations);
		const inherited = base?.uri ? this.collectMembers(base.uri, visited) : [];
		const result = [...own];
		for (const symbol of inherited) if (!result.some((candidate) => candidate.name === symbol.name)) result.push(symbol);
		return result;
	}
	private resolveExtends(declarations: GDScriptDeclaration[]): ResolvedType | undefined {
		const declaration = declarations.find((item) => item.kind === "extends");
		if (!declaration || declaration.kind !== "extends") return undefined;
		const reference = normalizeScriptReference(declaration.name);
		return reference.startsWith("res://") || reference.endsWith(".gd") ? this.resolveScriptPath(reference) : this.resolveName(reference);
	}
	private resolveScriptPath(value: string): ResolvedType | undefined {
		const path = normalizeScriptReference(value).replace(/^res:\/\//, "").replace(/^\/+/, "");
		const uri = this.files.findByPathSuffix(path);
		if (!uri) return undefined;
		const file = this.files.get(uri);
		const className = findScriptClassName(file);
		const symbol = className ? this.symbols.find(className).find((item) => item.uri === uri) : undefined;
		return { name: className ?? path.replace(/\.gd$/, ""), uri, symbol, builtin: false };
	}
	private getBodyStatements(uri: string, fn: GDScriptFunction): LocalStatement[] {
		const file = this.files.get(uri);
		if (!file || !fn.bodyRange) return [];
		const key = `${uri}:function:${fn.bodyRange.start.offset}:${fn.bodyRange.end.offset}`;
		const cached = this.statementCache.get(key);
		if (cached?.fingerprint === file.sourceFingerprint) return cached.statements;
		const statements = collectBodyStatements(file.source, fn.bodyRange);
		this.statementCache.set(key, { fingerprint: file.sourceFingerprint, statements });
		return statements;
	}
	private resolveExpressionType(uri: string, expression: string, offset: number, visited: Set<string>): ResolvedType | undefined {
		const value = stripComments(expression);
		const literal = literalType(value);
		if (literal) return this.resolveName(literal) ?? { name: literal, builtin: true };
		const conditional = splitConditional(value);
		if (conditional) {
			const left = this.resolveExpressionType(uri, conditional[0], offset, visited);
			const right = this.resolveExpressionType(uri, conditional[1], offset, visited);
			if (left && right && left.name === right.name) return left;
			return undefined;
		}
		const preload = value.match(/^preload\s*\(\s*["']([^"']+\.gd)["']\s*\)\s*\.\s*new\s*\(\s*\)$/);
		if (preload) return this.resolveScriptPath(preload[1]);
		const load = value.match(/^load\s*\(\s*["']([^"']+)["']\s*\)$/);
		if (load) return { name: "Resource", builtin: true };
		const constructed = value.match(/^([A-Za-z_]\w*)\s*\.\s*new\s*\(.*\)$/s);
		if (constructed) {
			if (CONSTRUCTOR_TYPES.has(constructed[1])) return this.resolveName(constructed[1]) ?? { name: constructed[1], builtin: true };
			const type = this.resolveName(constructed[1]);
			if (type) return type;
		}
		const memberCall = value.match(/^([A-Za-z_]\w*)\s*\.\s*([A-Za-z_]\w*)\s*\(.*\)$/s);
		if (memberCall) {
			const receiver = this.resolveReceiver(uri, offset, memberCall[1]);
			if (receiver) { const member = this.getMember(receiver, memberCall[2]); if (member) return this.resolveMemberReturnType(receiver, member); }
		}
		const memberAccess = value.match(/^([A-Za-z_]\w*)\s*\.\s*([A-Za-z_]\w*)$/s);
		if (memberAccess) {
			const receiver = this.resolveReceiver(uri, offset, memberAccess[1]);
			if (receiver) {
				const member = this.getMember(receiver, memberAccess[2]);
				if (member) return this.resolveMemberReturnType(receiver, member);
			}
		}
		const call = topLevelCall(value);
		if (call) {
			if (CONSTRUCTOR_TYPES.has(call.name)) return this.resolveName(call.name) ?? { name: call.name, builtin: true };
			const functions = this.symbols.find(call.name).filter((symbol) => symbol.kind === "function");
			if (functions.length === 1) { const fn = functions[0]; return fn.returnType ? this.resolveName(fn.returnType) : this.resolveFunctionReturnType(fn.uri, fn.name, visited); }
		}
		const binding = this.bindings.getBinding(uri, offset, value);
		if (binding) return this.resolveBinding(binding, offset);
		return this.resolveName(value);
	}
	private resolveInitializerType(uri: string, name: string, offset: number, visited: Set<string>): ResolvedType | undefined {
		const key = `${uri}:${name}:${offset}`;
		if (visited.has(key)) return undefined;
		visited.add(key);
		const file = this.files.get(uri);
		if (!file) return undefined;
		const declaration = findDeclaration(file, name);
		if (declaration?.type) return this.resolveName(declaration.type);
		if (declaration?.value) { const result = this.resolveExpressionType(uri, declaration.value, declaration.range.start.offset, visited); if (result) return result; }
		const functionDeclaration = findContainingFunction(file.ast.declarations, offset);
		if (!functionDeclaration) return undefined;
		const controlFlow = collectControlFlowAssignments(file.source, functionDeclaration.bodyRange, name, offset);
		if (controlFlow !== undefined) {
			if (!controlFlow.length) return undefined;
			let resolved: ResolvedType | undefined;
			for (const expression of controlFlow) {
				const type = this.resolveExpressionType(uri, expression, offset, new Set(visited));
				if (!type) return undefined;
				if (resolved && resolved.name !== type.name) return undefined;
				resolved = type;
			}
			if (resolved) return resolved;
		}
		const statements = this.getBodyStatements(uri, functionDeclaration);
		let latest: LocalStatement | undefined;
		for (const statement of statements) if (statement.kind === "assignment" && statement.name === name && statement.offset <= offset) latest = statement;
		if (!latest?.expression || latest.expressionOffset === undefined) return undefined;
		return this.resolveExpressionType(uri, latest.expression, latest.expressionOffset, visited);
	}
	private resolveFunctionReturnTypeForSymbol(member: IndexedSymbol, visited: Set<string>): ResolvedType | undefined {
		const file = this.files.get(member.uri);
		if (!file) return undefined;
		const declaration = findFunctionAt(file.ast.declarations, member.range.start.offset);
		if (!declaration) return this.resolveFunctionReturnType(member.uri, member.name, visited);
		if (declaration.returnType) return this.resolveName(declaration.returnType);
		const returns = this.getBodyStatements(member.uri, declaration).filter((statement) => statement.kind === "return");
		if (!returns.length) return undefined;
		let resolved: ResolvedType | undefined;
		for (const item of returns) {
			const type = this.resolveExpressionType(member.uri, item.expression, item.expressionOffset, visited);
			if (!type) return undefined;
			if (resolved && resolved.name !== type.name) return undefined;
			resolved = type;
		}
		return resolved;
	}
	private resolveFunctionReturnType(uri: string, name: string, visited: Set<string>): ResolvedType | undefined {
		const key = `${uri}:function:${name}`;
		if (visited.has(key)) return undefined;
		visited.add(key);
		const file = this.files.get(uri);
		if (!file) return undefined;
		const functions = findFunctions(file.ast.declarations, name);
		if (functions.length !== 1) return undefined;
		const fn = functions[0];
		if (fn.returnType) return this.resolveName(fn.returnType);
		const returns = this.getBodyStatements(uri, fn).filter((statement): statement is Extract<LocalStatement, { kind: "return" }> => statement.kind === "return");
		if (!returns.length) return undefined;
		let resolved: ResolvedType | undefined;
		for (const item of returns) {
			const type = this.resolveExpressionType(uri, item.expression, item.expressionOffset, visited);
			if (!type) return undefined;
			if (resolved && resolved.name !== type.name) return undefined;
			resolved = type;
		}
		return resolved;
	}
}
