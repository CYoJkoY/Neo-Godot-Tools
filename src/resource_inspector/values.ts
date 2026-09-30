/**
 * Godot text-resource value handling for the Resource Inspector.
 *
 * The inspector edits `.tres` files as text, so every widget works with a
 * `VariantValue`: a structured view of one property value that can be parsed
 * from the file and formatted back without losing the original representation.
 */

export type VariantKind =
	| "bool"
	| "int"
	| "float"
	| "String"
	| "StringName"
	| "NodePath"
	| "Color"
	| "Vector2"
	| "Vector2i"
	| "Vector3"
	| "Vector3i"
	| "Vector4"
	| "Vector4i"
	| "Rect2"
	| "Rect2i"
	| "Transform2D"
	| "Transform3D"
	| "Basis"
	| "Quaternion"
	| "Plane"
	| "AABB"
	| "Array"
	| "Dictionary"
	| "PackedByteArray"
	| "PackedInt32Array"
	| "PackedInt64Array"
	| "PackedFloat32Array"
	| "PackedFloat64Array"
	| "PackedStringArray"
	| "PackedVector2Array"
	| "PackedVector3Array"
	| "PackedVector4Array"
	| "PackedColorArray"
	| "ExtResource"
	| "SubResource"
	| "Variant";

export interface DictionaryEntry {
	key: VariantValue;
	value: VariantValue;
}

export interface VariantValue {
	kind: VariantKind;
	/** Text as it appears in the file; for edited values it is regenerated. */
	raw: string;
	number?: number;
	text?: string;
	components?: number[];
	items?: VariantValue[];
	entries?: DictionaryEntry[];
	referenceId?: string;
	/** Element type of a typed `Array[...]`. */
	arrayType?: string;
}

export interface ParseResult {
	value: VariantValue;
	error?: string;
}

const CONSTRUCTORS: Record<string, { kind: VariantKind; components: number }> = {
	Vector2: { kind: "Vector2", components: 2 },
	Vector2i: { kind: "Vector2i", components: 2 },
	Vector3: { kind: "Vector3", components: 3 },
	Vector3i: { kind: "Vector3i", components: 3 },
	Vector4: { kind: "Vector4", components: 4 },
	Vector4i: { kind: "Vector4i", components: 4 },
	Color: { kind: "Color", components: 4 },
	Rect2: { kind: "Rect2", components: 4 },
	Rect2i: { kind: "Rect2i", components: 4 },
	Quaternion: { kind: "Quaternion", components: 4 },
	Plane: { kind: "Plane", components: 4 },
	AABB: { kind: "AABB", components: 6 },
	Basis: { kind: "Basis", components: 9 },
	Transform2D: { kind: "Transform2D", components: 6 },
	Transform3D: { kind: "Transform3D", components: 12 },
};

const PACKED_ARRAYS: Record<string, VariantKind> = {
	PackedByteArray: "PackedByteArray",
	PackedInt32Array: "PackedInt32Array",
	PackedInt64Array: "PackedInt64Array",
	PackedFloat32Array: "PackedFloat32Array",
	PackedFloat64Array: "PackedFloat64Array",
	PackedStringArray: "PackedStringArray",
	PackedVector2Array: "PackedVector2Array",
	PackedVector3Array: "PackedVector3Array",
	PackedVector4Array: "PackedVector4Array",
	PackedColorArray: "PackedColorArray",
};

const COMPONENT_COUNTS: Record<string, number> = {
	Vector2: 2, Vector2i: 2, Vector3: 3, Vector3i: 3, Vector4: 4, Vector4i: 4,
	Color: 4, Rect2: 4, Rect2i: 4, Quaternion: 4, Plane: 4, AABB: 6, Basis: 9,
	Transform2D: 6, Transform3D: 12,
};

/** Godot type names that map onto a numeric/primitive widget. */
export function variantKindForType(type: string): VariantKind {
	const normalized = normalizeTypeName(type);
	if (CONSTRUCTORS[normalized]) return CONSTRUCTORS[normalized].kind;
	if (PACKED_ARRAYS[normalized]) return PACKED_ARRAYS[normalized];
	switch (normalized) {
		case "bool": return "bool";
		case "int": return "int";
		case "float": return normalized as VariantKind;
		case "String": return "String";
		case "StringName": return "StringName";
		case "NodePath": return "NodePath";
		case "Array": return "Array";
		case "Dictionary": return "Dictionary";
		case "Object": return "ExtResource";
		default: return "Variant";
	}
}

export function componentCount(type: string): number | undefined {
	return COMPONENT_COUNTS[normalizeTypeName(type)];
}

export function isArrayType(type: string): boolean {
	const normalized = normalizeTypeName(type);
	return normalized === "Array" || normalized.startsWith("Array[") || normalized in PACKED_ARRAYS;
}

export function isResourceType(type: string): boolean {
	const normalized = normalizeTypeName(type);
	if (["Resource", "Texture", "Texture2D", "Material", "Mesh", "Script", "PackedScene", "Font"].includes(normalized)) return true;
	return normalized.endsWith("Resource") || normalized.endsWith("Material") || normalized.endsWith("Texture") || normalized.endsWith("Mesh");
}

/** Strips array suffixes and enum hints from a declared type. */
export function normalizeTypeName(type: string): string {
	let normalized = type.trim();
	const array = normalized.match(/^Array\[([^\]]*)\]$/);
	if (array) normalized = "Array";
	normalized = normalized.replace(/\s*:.*$/, "");
	return normalized;
}

function splitTopLevel(text: string, separator = ","): string[] {
	const parts: string[] = [];
	let depth = 0;
	let quoted: string | undefined;
	let start = 0;
	for (let index = 0; index < text.length; index++) {
		const char = text[index];
		if (quoted) {
			if (char === "\\") index++;
			else if (char === quoted) quoted = undefined;
			continue;
		}
		if (char === '"' || char === "'") { quoted = char; continue; }
		if (char === "(" || char === "[" || char === "{") depth++;
		else if (char === ")" || char === "]" || char === "}") depth--;
		else if (char === separator && depth === 0) {
			parts.push(text.slice(start, index).trim());
			start = index + 1;
		}
	}
	const tail = text.slice(start).trim();
	if (tail) parts.push(tail);
	return parts;
}

function unescapeText(text: string): string {
	return text.replace(/\\(.)/g, (_match, char: string) => {
		switch (char) {
			case "n": return "\n";
			case "t": return "\t";
			case "r": return "\r";
			default: return char;
		}
	});
}

function parseQuoted(text: string): { text: string } | undefined {
	if (text.length < 2) return undefined;
	const quote = text[0];
	if ((quote !== '"' && quote !== "'") || text[text.length - 1] !== quote) return undefined;
	return { text: unescapeText(text.slice(1, -1)) };
}

/** Parses one Godot variant literal. Unknown syntax yields a `Variant` value and an error. */
export function parseVariant(raw: string): ParseResult {
	const text = raw.trim();
	if (!text) return { value: { kind: "Variant", raw: text }, error: "empty value" };
	if (text === "null") return { value: { kind: "Variant", raw: text } };
	if (text === "true" || text === "false") return { value: { kind: "bool", raw: text, number: text === "true" ? 1 : 0 } };

	if (/^[+-]?\d+$/.test(text)) return { value: { kind: "int", raw: text, number: Number.parseInt(text, 10) } };
	if (/^[+-]?(\d+\.\d*|\.\d+|\d+)([eE][+-]?\d+)?$/.test(text) && /[.eE]/.test(text)) {
		return { value: { kind: "float", raw: text, number: Number.parseFloat(text) } };
	}

	if (text.startsWith("&")) {
		const inner = parseQuoted(text.slice(1).trim());
		if (!inner) return { value: { kind: "Variant", raw: text }, error: "invalid StringName" };
		return { value: { kind: "StringName", raw: text, text: inner.text } };
	}
	const quoted = parseQuoted(text);
	if (quoted) return { value: { kind: "String", raw: text, text: quoted.text } };

	const nodePath = text.match(/^NodePath\(([\s\S]*)\)$/);
	if (nodePath) {
		const inner = parseQuoted(nodePath[1].trim());
		if (!inner) return { value: { kind: "Variant", raw: text }, error: "invalid NodePath" };
		return { value: { kind: "NodePath", raw: text, text: inner.text } };
	}

	const reference = text.match(/^(Ext|Sub)Resource\(\s*"([^"]*)"\s*\)$/);
	if (reference) {
		return { value: { kind: reference[1] === "Ext" ? "ExtResource" : "SubResource", raw: text, referenceId: reference[2] } };
	}

	const typedArray = text.match(/^Array\[([^\]]*)\]\(([\s\S]*)\)$/);
	if (typedArray) {
		// Godot writes the value as `Array[T]([...])`; accept a bare list too.
		let body = typedArray[2].trim();
		if (body.startsWith("[") && body.endsWith("]")) body = body.slice(1, -1);
		const items = splitTopLevel(body).map((item) => parseVariant(item));
		const error = items.find((item) => item.error)?.error;
		return {
			value: { kind: "Array", raw: text, arrayType: typedArray[1].trim(), items: items.map((item) => item.value) },
			error: error ? `invalid array entry: ${error}` : undefined,
		};
	}

	if (text.startsWith("[") && text.endsWith("]")) {
		const items = splitTopLevel(text.slice(1, -1)).map((item) => parseVariant(item));
		const error = items.find((item) => item.error)?.error;
		return {
			value: { kind: "Array", raw: text, items: items.map((item) => item.value) },
			error: error ? `invalid array entry: ${error}` : undefined,
		};
	}

	if (text.startsWith("{") && text.endsWith("}")) {
		const body = text.slice(1, -1).trim();
		const entries: DictionaryEntry[] = [];
		let error: string | undefined;
		for (const part of splitTopLevel(body)) {
			const separator = part.indexOf(":");
			if (separator === -1) { error = `invalid dictionary entry: ${part}`; continue; }
			const key = parseVariant(part.slice(0, separator));
			const value = parseVariant(part.slice(separator + 1));
			error = error ?? key.error ?? value.error;
			entries.push({ key: key.value, value: value.value });
		}
		return { value: { kind: "Dictionary", raw: text, entries }, error: error ? `invalid dictionary entry: ${error}` : undefined };
	}

	const constructorMatch = text.match(/^([A-Za-z_][A-Za-z0-9_]*)\(([\s\S]*)\)$/);
	if (constructorMatch) {
		const name = constructorMatch[1];
		const args = splitTopLevel(constructorMatch[2]);
		if (PACKED_ARRAYS[name]) {
			const items = args.map((item) => parseVariant(item));
			const error = items.find((item) => item.error)?.error;
			return {
				value: { kind: PACKED_ARRAYS[name], raw: text, items: items.map((item) => item.value) },
				error: error ? `invalid array entry: ${error}` : undefined,
			};
		}
		const descriptor = CONSTRUCTORS[name];
		if (descriptor) {
			const components = args.map((item) => Number(item));
			if (components.length !== descriptor.components || components.some((component) => Number.isNaN(component))) {
				return { value: { kind: descriptor.kind, raw: text }, error: `expected ${descriptor.components} numeric components` };
			}
			return { value: { kind: descriptor.kind, raw: text, components } };
		}
		return { value: { kind: "Variant", raw: text }, error: `unsupported constructor ${name}` };
	}

	return { value: { kind: "Variant", raw: text }, error: `unparsable value: ${text}` };
}

function formatNumber(component: number): string {
	if (Number.isInteger(component)) return String(component);
	return String(Number(component.toFixed(6)));
}

function quote(text: string): string {
	return `"${text.replace(/\\/g, "\\\\").replace(/"/g, '\\"').replace(/\n/g, "\\n").replace(/\t/g, "\\t")}"`;
}

export function formatVariant(value: VariantValue): string {
	switch (value.kind) {
		case "bool": return value.number ? "true" : "false";
		case "int": return String(Math.trunc(value.number ?? 0));
		case "float": {
			const number = value.number ?? 0;
			return Number.isInteger(number) ? `${number}.0` : formatNumber(number);
		}
		case "String": return quote(value.text ?? "");
		case "StringName": return `&${quote(value.text ?? "")}`;
		case "NodePath": return `NodePath(${quote(value.text ?? "")})`;
		case "ExtResource": return `ExtResource(${quote(value.referenceId ?? "")})`;
		case "SubResource": return `SubResource(${quote(value.referenceId ?? "")})`;
		case "Array": {
			const items = (value.items ?? []).map(formatVariant).join(", ");
			const literal = `[${items}]`;
			return value.arrayType ? `Array[${value.arrayType}](${literal})` : literal;
		}
		case "Dictionary": {
			const entries = (value.entries ?? []).map((entry) => `${formatVariant(entry.key)}: ${formatVariant(entry.value)}`).join(", ");
			return `{${entries}}`;
		}
		default: {
			if (value.kind in PACKED_ARRAYS) return `${value.kind}(${(value.items ?? []).map(formatVariant).join(", ")})`;
			const components = value.components;
			if (components?.length) return `${value.kind}(${components.map(formatNumber).join(", ")})`;
			return value.raw.trim();
		}
	}
}

/** Regenerates the textual value after its components/entries were edited. */
export function withComponents(kind: VariantKind, components: number[]): VariantValue {
	return { kind, components, raw: `${kind}(${components.map(formatNumber).join(", ")})` };
}

export function withItems(kind: VariantKind, items: VariantValue[], arrayType?: string): VariantValue {
	return { kind, items, arrayType, raw: formatVariant({ kind, items, arrayType, raw: "" }) };
}

/** True when a parsed value can be assigned to a property of `type`. */
export function valueMatchesType(value: VariantValue, type: string): boolean {
	const expected = variantKindForType(type);
	if (expected === "Variant") return true;
	if (value.kind === "Variant") return false;
	if (expected === "Array") return value.kind === "Array" || value.kind in PACKED_ARRAYS;
	if (expected === "ExtResource") {
		return value.kind === "ExtResource" || value.kind === "SubResource" || value.raw === "null";
	}
	if (expected === "int") return value.kind === "int" || value.kind === "float";
	if (expected === "float") return value.kind === "float" || value.kind === "int";
	return value.kind === expected;
}
