import { GDScriptDeclaration } from "../analyzer/index.js";
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

function findDeclarationType(file: ReturnType<FileIndex["get"]>, name: string): string | undefined {
	if (!file) return undefined;
	const visit = (declarations: GDScriptDeclaration[]): string | undefined => {
		for (const declaration of declarations) {
			if ((declaration.kind === "variable" || declaration.kind === "constant") && declaration.name === name) return declaration.type;
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

export class TypeResolutionIndex {
	private readonly nameCache = new Map<string, { signature: string; value: ResolvedType | null }>();
	private readonly memberCache = new Map<string, { signature: string; members: IndexedSymbol[] }>();

	constructor(
		private readonly files: FileIndex,
		private readonly symbols: SymbolIndex,
		private readonly bindings: BindingIndex,
	) {}

	resolveName(name: string): ResolvedType | undefined {
		if (BUILTIN_TYPES.has(name)) return { name, builtin: true };
		const matches = this.symbols.find(name).filter((symbol) => symbol.kind === "class_name" || symbol.kind === "class");
		const signature = matches.map((symbol) => `${symbol.uri}:${symbol.range.start.offset}:${symbol.range.end.offset}`).join("|");
		const cached = this.nameCache.get(name);
		if (cached && cached.signature === signature) return cached.value ?? undefined;
		if (matches.length !== 1) {
			this.nameCache.set(name, { signature, value: null });
			return undefined;
		}
		const result = { name, uri: matches[0].uri, symbol: matches[0], builtin: false } satisfies ResolvedType;
		this.nameCache.set(name, { signature, value: result });
		return result;
	}

	resolveBinding(binding: Binding): ResolvedType | undefined {
		if (binding.type) return this.resolveName(binding.type);
		if (binding.kind !== "function" || !binding.returnType) return undefined;
		return this.resolveName(binding.returnType);
	}

	resolveReceiver(uri: string, offset: number, name: string): ResolvedType | undefined {
		if (name === "self") return { name: "self", uri, builtin: false };
		const preload = this.resolvePreloadExpression(name);
		if (preload) return preload;
		const binding = this.bindings.getBinding(uri, offset, name);
		const bindingType = binding ? this.resolveBinding(binding) : undefined;
		if (bindingType) return bindingType;
		const expressionType = this.resolveInitializerType(uri, name);
		if (expressionType) return expressionType;
		const declarationType = findDeclarationType(this.files.get(uri), name);
		return declarationType ? this.resolveName(declarationType) : undefined;
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
		if (declaration.name.startsWith("res://")) return this.resolveScriptPath(declaration.name);
		return this.resolveName(declaration.name);
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

	private resolvePreloadExpression(expression: string): ResolvedType | undefined {
		const match = expression.match(/^preload\s*\(\s*["']([^"']+\.gd)["']\s*\)\.new\(\)$/);
		return match ? this.resolveScriptPath(match[1]) : undefined;
	}

	private resolveInitializerType(uri: string, name: string): ResolvedType | undefined {
		const source = this.files.get(uri)?.source;
		if (!source) return undefined;
		const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
		const pattern = new RegExp(`(?:^|\\n)\\s*var\\s+${escaped}\\s*(?:\\:\\s*[^=]+)?=\\s*([^\\n#]+)`);
		const match = source.match(pattern);
		if (!match) return undefined;
		const expression = match[1].trim();
		const preload = this.resolvePreloadExpression(expression);
		if (preload) return preload;
		const call = expression.match(/^([A-Za-z_]\w*)\s*\([^)]*\)$/);
		if (!call) return undefined;
		const functions = this.symbols.find(call[1]).filter((symbol) => symbol.kind === "function" && symbol.returnType);
		if (functions.length !== 1) return undefined;
		return this.resolveName(functions[0].returnType!);
	}
}
