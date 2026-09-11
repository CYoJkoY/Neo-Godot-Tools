import { GDScriptDeclaration } from "../analyzer/index.js";
import { Binding, BindingIndex } from "./bindings.js";
import { FileIndex } from "./file_index.js";
import { IndexedSymbol, SymbolIndex } from "./symbol.js";

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

export class TypeResolutionIndex {
	constructor(
		private readonly files: FileIndex,
		private readonly symbols: SymbolIndex,
		private readonly bindings: BindingIndex,
	) {}

	resolveName(name: string): ResolvedType | undefined {
		if (BUILTIN_TYPES.has(name)) return { name, builtin: true };
		const matches = this.symbols.find(name).filter((symbol) => symbol.kind === "class_name" || symbol.kind === "class");
		if (matches.length !== 1) return undefined;
		return { name, uri: matches[0].uri, symbol: matches[0], builtin: false };
	}

	resolveBinding(binding: Binding): ResolvedType | undefined {
		if (!binding.type) return undefined;
		return this.resolveName(binding.type);
	}

	resolveReceiver(uri: string, offset: number, name: string): ResolvedType | undefined {
		if (name === "self") return { name: "self", uri, builtin: false };
		const binding = this.bindings.getBinding(uri, offset, name);
		if (binding) return this.resolveBinding(binding);
		const declarationType = findDeclarationType(this.files.get(uri), name);
		return declarationType ? this.resolveName(declarationType) : undefined;
	}

	getMembers(type: ResolvedType): IndexedSymbol[] {
		if (!type.uri) return [];
		return this.files.get(type.uri)?.symbols.filter((symbol) => symbol.containerName === type.symbol?.name || !symbol.containerName) ?? [];
	}

	getMember(type: ResolvedType, name: string): IndexedSymbol | undefined {
		const members = this.getMembers(type).filter((symbol) => symbol.name === name);
		return members.length === 1 ? members[0] : undefined;
	}
}
