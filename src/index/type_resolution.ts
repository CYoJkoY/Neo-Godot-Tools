import { GDScriptConstant, GDScriptDeclaration, GDScriptFunction, GDScriptVariable } from "../analyzer/index.js";
import { Binding, BindingIndex } from "./bindings.js";
import { FileIndex } from "./file_index.js";
import { IndexedSymbol } from "./symbol.js";
import { SymbolIndex } from "./symbol_index.js";

export interface ResolvedType {
	name: string;
	uri?: string;
	symbol?: IndexedSymbol;
	builtin: boolean;
}

const BUILTIN_TYPES = new Set([
	"bool", "int", "float", "String", "StringName", "Node", "Node2D", "Node3D", "Control", "Object",
	"RefCounted", "Resource", "Array", "Dictionary", "Callable", "Signal", "Variant", "Vector2", "Vector2i",
	"Vector3", "Vector3i", "Vector4", "Vector4i", "Color", "Rect2", "Rect2i", "Transform2D", "Transform3D",
	"Basis", "Quaternion", "Plane", "AABB", "RID", "PackedByteArray", "PackedInt32Array", "PackedInt64Array",
	"PackedFloat32Array", "PackedFloat64Array", "PackedStringArray", "PackedVector2Array", "PackedVector3Array",
	"PackedColorArray",
]);

const CONSTRUCTOR_TYPES = new Set([
	"StringName", "Vector2", "Vector2i", "Vector3", "Vector3i", "Vector4", "Vector4i", "Color", "Rect2", "Rect2i",
	"Transform2D", "Transform3D", "Basis", "Quaternion", "Plane", "AABB", "RID", "Array", "Dictionary", "Callable",
]);

function findDeclaration(file: ReturnType<FileIndex["get"]>, name: string): GDScriptVariable | GDScriptConstant | undefined {
	if (!file) return undefined;
	const visit = (declarations: GDScriptDeclaration[]): GDScriptVariable | GDScriptConstant | undefined => {
		for (const declaration of declarations) {
			if ((declaration.kind === "variable" || declaration.kind === "constant") && declaration.name === name) return declaration;
			if (declaration.kind === "class") {
				const nested = visit(declaration.declarations);
				if (nested) return nested;
			}
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
	return expression.replace(/\s+#.*$/, "").trim();
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

function findContainingFunction(declarations: GDScriptDeclaration[], offset: number): GDScriptFunction | undefined {
	for (const declaration of declarations) {
		if (
			declaration.kind === "function" &&
			declaration.bodyRange &&
			declaration.bodyRange.start.offset <= offset &&
			offset <= declaration.bodyRange.end.offset
		) return declaration;
		if (declaration.kind === "class") {
			const nested = findContainingFunction(declaration.declarations, offset);
			if (nested) return nested;
		}
	}
	return undefined;
}

export class TypeResolutionIndex {
	private readonly nameCache = new Map<string, { signature: string; value: ResolvedType | null }>();
	private readonly memberCache = new Map<string, { signature: string; members: IndexedSymbol[] }>();

	constructor(
		private readonly files: FileIndex,
		private readonly symbols: SymbolIndex,
		private readonly bindings: BindingIndex,
	) {}

	resolveName(name: string): ResolvedType | undefined {
		const normalized = name.trim().replace(/^const\s+/, "");
		if (BUILTIN_TYPES.has(normalized)) return { name: normalized, builtin: true };
		const matches = this.symbols.find(normalized).filter((symbol) => symbol.kind === "class_name" || symbol.kind === "class");
		const signature = matches.map((symbol) => `${symbol.uri}:${symbol.range.start.offset}:${symbol.range.end.offset}`).join("|");
		const cached = this.nameCache.get(normalized);
		if (cached && cached.signature === signature) return cached.value ?? undefined;
		if (matches.length !== 1) {
			this.nameCache.set(normalized, { signature, value: null });
			return undefined;
		}
		const result = { name: normalized, uri: matches[0].uri, symbol: matches[0], builtin: false } satisfies ResolvedType;
		this.nameCache.set(normalized, { signature, value: result });
		return result;
	}

	resolveBinding(binding: Binding, offset = binding.declarationRange.start.offset): ResolvedType | undefined {
		if (binding.type) return this.resolveName(binding.type);
		if (binding.kind === "function") {
			if (binding.returnType) return this.resolveName(binding.returnType);
			return this.resolveFunctionReturnType(binding.uri, binding.name, new Set<string>());
		}
		return this.resolveInitializerType(binding.uri, binding.name, offset, new Set<string>());
	}

	resolveReceiver(uri: string, offset: number, name: string): ResolvedType | undefined {
		if (name === "self") return { name: "self", uri, builtin: false };
		const binding = this.bindings.getBinding(uri, offset, name);
		if (binding) {
			const type = this.resolveBinding(binding, offset);
			if (type) return type;
		}
		return this.resolveInitializerType(uri, name, offset, new Set<string>());
	}

	getMembers(type: ResolvedType): IndexedSymbol[] {
		if (!type.uri) return [];
		const signature = this.memberSignature(type.uri, new Set<string>());
		const cached = this.memberCache.get(type.uri);
		if (cached && cached.signature === signature) return cached.members;
		const members = this.collectMembers(type.uri, new Set<string>());
		this.memberCache.set(type.uri, { signature, members });
		return members;
	}

	getMember(type: ResolvedType, name: string): IndexedSymbol | undefined {
		const members = this.getMembers(type).filter((symbol) => symbol.name === name);
		return members.length === 1 ? members[0] : undefined;
	}

	resolveMemberReturnType(type: ResolvedType, member: IndexedSymbol): ResolvedType | undefined {
		if (member.returnType) return this.resolveName(member.returnType);
		if (member.kind !== "function") return undefined;
		return this.resolveFunctionReturnType(member.uri, member.name, new Set<string>());
	}

	invalidate(uris: Iterable<string>): void {
		const affected = new Set(uris);
		for (const [uri] of this.memberCache) if (affected.has(uri)) this.memberCache.delete(uri);
		for (const [name, cached] of this.nameCache) if (cached.value?.uri && affected.has(cached.value.uri)) this.nameCache.delete(name);
		if (affected.size) for (const [name, cached] of this.nameCache) if (cached.value === null) this.nameCache.delete(name);
	}

	clear(): void {
		this.nameCache.clear();
		this.memberCache.clear();
	}

	private memberSignature(uri: string, visited: Set<string>): string {
		if (visited.has(uri)) return `cycle:${uri}`;
		visited.add(uri);
		const file = this.files.get(uri);
		if (!file) return `missing:${uri}`;
		const base = this.resolveExtends(file.ast.declarations);
		return `${uri}@${file.apiFingerprint}[${base?.uri ? this.memberSignature(base.uri, visited) : ""}]`;
	}

	private collectMembers(uri: string, visited: Set<string>): IndexedSymbol[] {
		if (visited.has(uri)) return [];
		visited.add(uri);
		const file = this.files.get(uri);
		if (!file) return [];
		const own = file.symbols.filter((symbol) => !symbol.containerName);
		const base = this.resolveExtends(file.ast.declarations);
		const inherited = base?.uri ? this.collectMembers(base.uri, visited) : [];
		const result = [...own];
		for (const symbol of inherited) if (!result.some((candidate) => candidate.name === symbol.name)) result.push(symbol);
		return result;
	}

	private resolveExtends(declarations: GDScriptDeclaration[]): ResolvedType | undefined {
		const declaration = declarations.find((item) => item.kind === "extends");
		if (!declaration || declaration.kind !== "extends") return undefined;
		return declaration.name.startsWith("res://") ? this.resolveScriptPath(declaration.name) : this.resolveName(declaration.name);
	}

	private resolveScriptPath(value: string): ResolvedType | undefined {
		const path = value.replace(/^res:\/\//, "").replace(/\\/g, "/").replace(/^\/+/, "");
		const matches = [...this.files.values()].filter((file) => {
			try {
				return decodeURIComponent(new URL(file.uri).pathname).replace(/^\/+/, "").endsWith(path);
			} catch {
				return file.uri.endsWith(path);
			}
		});
		if (matches.length !== 1) return undefined;
		const className = findScriptClassName(matches[0]);
		const symbol = className ? this.symbols.find(className).find((item) => item.uri === matches[0].uri) : undefined;
		return { name: className ?? path.replace(/\.gd$/, ""), uri: matches[0].uri, symbol, builtin: false };
	}

	private resolveExpressionType(uri: string, expression: string, offset: number, visited: Set<string>): ResolvedType | undefined {
		const value = stripComments(expression);
		const literal = literalType(value);
		if (literal) return this.resolveName(literal) ?? { name: literal, builtin: true };
		const preload = value.match(/^preload\s*\(\s*["']([^"']+\.gd)["']\s*\)\.new\s*\(\s*\)$/);
		if (preload) return this.resolveScriptPath(preload[1]);
		const load = value.match(/^load\s*\(\s*["']([^"']+)["']\s*\)$/);
		if (load) return { name: "Resource", builtin: true };
		const memberCall = value.match(/^([A-Za-z_]\w*)\.([A-Za-z_]\w*)\s*\(.*\)$/s);
		if (memberCall) {
			const receiver = this.resolveReceiver(uri, offset, memberCall[1]);
			if (receiver) {
				const member = this.getMember(receiver, memberCall[2]);
				if (member) return this.resolveMemberReturnType(receiver, member);
			}
		}
		const call = topLevelCall(value);
		if (call) {
			if (CONSTRUCTOR_TYPES.has(call.name)) return this.resolveName(call.name) ?? { name: call.name, builtin: true };
			const functions = this.symbols.find(call.name).filter((symbol) => symbol.kind === "function");
			if (functions.length === 1) {
				const fn = functions[0];
				if (fn.returnType) return this.resolveName(fn.returnType);
				return this.resolveFunctionReturnType(fn.uri, fn.name, visited);
			}
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
		if (declaration?.value) {
			const result = this.resolveExpressionType(uri, declaration.value, declaration.range.start.offset, visited);
			if (result) return result;
		}
		const functionDeclaration = findContainingFunction(file.ast.declarations, offset);
		const searchStart = functionDeclaration?.bodyRange?.start.offset ?? 0;
		const searchEnd = Math.min(offset, functionDeclaration?.bodyRange?.end.offset ?? file.source.length);
		const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
		const assignment = new RegExp(
			`(?:^|\\n)\\s*(?:var\\s+)?${escaped}(?:\\s*:\\s*[^=]+)?\\s*=\\s*([^\\n#]+)`,
			"g",
		);
		let latest: string | undefined;
		let match: RegExpExecArray | null;
		const source = file.source.slice(searchStart, searchEnd);
		while (true) {
			match = assignment.exec(source);
			if (!match) break;
			latest = match[1];
		}
		return latest ? this.resolveExpressionType(uri, latest, searchEnd, visited) : undefined;
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
		if (!fn.bodyRange) return undefined;
		const body = file.source.slice(fn.bodyRange.start.offset, fn.bodyRange.end.offset);
		const pattern = /(?:^|\n)\s*return\s+([^\n#]+)/g;
		const returns: Array<{ expression: string; offset: number }> = [];
		let match: RegExpExecArray | null;
		while (true) {
			match = pattern.exec(body);
			if (!match) break;
			returns.push({
				expression: match[1],
				offset: fn.bodyRange.start.offset + match.index + match[0].lastIndexOf(match[1]),
			});
		}
		if (!returns.length) return undefined;
		let resolved: ResolvedType | undefined;
		for (const item of returns) {
			const type = this.resolveExpressionType(uri, item.expression, item.offset, visited);
			if (!type) return undefined;
			if (resolved && resolved.name !== type.name) return undefined;
			resolved = type;
		}
		return resolved;
	}
}
