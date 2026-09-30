/**
 * Godot text-resource value handling for the Resource Inspector.
 *
 * The inspector edits `.tres` files as text, so every widget works with a
 * `VariantValue`: a structured view of one property value that can be parsed
 * from the file and formatted back without losing the original representation.
 *
 * The parser mirrors what Godot's own text-resource parser accepts, including
 * the Godot 3 spellings (`PoolColorArray`, `Transform`, `ExtResource( 1 )`, …)
 * that still show up in older projects. Anything Godot would load must parse
 * without an error here: an editor that flags valid files is worse than no
 * editor at all.
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
	| "Projection"
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
	/** Key and value types of a typed `Dictionary[K, V](...)`. */
	dictionaryTypes?: [string, string];
	/**
	 * Constructor name as spelled in the file. Godot 3 projects write
	 * `PoolColorArray`/`Transform`/`StringName("…")` where Godot 4 writes
	 * `PackedColorArray`/`Transform3D`/`&"…"`; both stay loadable, so the
	 * original spelling is preserved when a value is written back.
	 */
	typeName?: string;
	/** `ExtResource( 1 )`/`SubResource( 2 )`: Godot 3 leaves the id unquoted. */
	unquoted?: boolean;
	/** The value was written as a `#rrggbb` colour literal. */
	hex?: boolean;
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
	Projection: { kind: "Projection", components: 16 },
	// Godot 3 spellings, still found in `.tres`/`.tscn` files of older projects.
	Quat: { kind: "Quaternion", components: 4 },
	Rect3: { kind: "AABB", components: 6 },
	Matrix3: { kind: "Basis", components: 9 },
	Matrix32: { kind: "Transform2D", components: 6 },
	Transform: { kind: "Transform3D", components: 12 },
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
	// Godot 3 spellings of the packed arrays above.
	PoolByteArray: "PackedByteArray",
	PoolIntArray: "PackedInt32Array",
	PoolRealArray: "PackedFloat32Array",
	PoolStringArray: "PackedStringArray",
	PoolVector2Array: "PackedVector2Array",
	PoolVector3Array: "PackedVector3Array",
	PoolColorArray: "PackedColorArray",
};

const COMPONENT_COUNTS: Record<string, number> = {
	Vector2: 2,
	Vector2i: 2,
	Vector3: 3,
	Vector3i: 3,
	Vector4: 4,
	Vector4i: 4,
	Color: 4,
	Rect2: 4,
	Rect2i: 4,
	Quaternion: 4,
	Plane: 4,
	AABB: 6,
	Basis: 9,
	Transform2D: 6,
	Transform3D: 12,
	Projection: 16,
	Quat: 4,
	Rect3: 6,
	Matrix3: 9,
	Matrix32: 6,
	Transform: 12,
};

/**
 * Constructors Godot accepts but that carry no editable structure
 * (`RID()`, `Signal("pressed")`, `Callable()`, `Object("Node", …)`). They are
 * kept verbatim instead of being reported as errors.
 */
const OPAQUE_CONSTRUCTORS = new Set(["RID", "Signal", "Callable", "Object"]);

/** `inf`/`-inf`/`nan` have no JavaScript spelling that round-trips. */
const SPECIAL_FLOATS: Record<string, number> = {
	inf: Number.POSITIVE_INFINITY,
	"-inf": Number.NEGATIVE_INFINITY,
	inf_neg: Number.NEGATIVE_INFINITY,
	nan: Number.NaN,
};

/** `#rgb`, `#rgba`, `#rrggbb` and `#rrggbbaa` colour literals. */
const HEX_COLOR_RE = /^#(?:[0-9a-fA-F]{3}|[0-9a-fA-F]{4}|[0-9a-fA-F]{6}|[0-9a-fA-F]{8})$/;

/** Godot type names that map onto a numeric/primitive widget. */
export function variantKindForType(type: string): VariantKind {
	const normalized = normalizeTypeName(type);
	if (CONSTRUCTORS[normalized]) return CONSTRUCTORS[normalized].kind;
	if (PACKED_ARRAYS[normalized]) return PACKED_ARRAYS[normalized];
	switch (normalized) {
		case "bool":
			return "bool";
		case "int":
			return "int";
		case "float":
			return normalized as VariantKind;
		case "String":
			return "String";
		case "StringName":
			return "StringName";
		case "NodePath":
			return "NodePath";
		case "Array":
			return "Array";
		case "Dictionary":
			return "Dictionary";
		case "Object":
			return "ExtResource";
		default:
			return "Variant";
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
	if (["Resource", "Texture", "Texture2D", "Material", "Mesh", "Script", "PackedScene", "Font"].includes(normalized))
		return true;
	return (
		normalized.endsWith("Resource") ||
		normalized.endsWith("Material") ||
		normalized.endsWith("Texture") ||
		normalized.endsWith("Mesh")
	);
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
		if (char === '"' || char === "'") {
			quoted = char;
			continue;
		}
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
			case "n":
				return "\n";
			case "t":
				return "\t";
			case "r":
				return "\r";
			default:
				return char;
		}
	});
}

function parseQuoted(text: string): { text: string } | undefined {
	if (text.length < 2) return undefined;
	const quote = text[0];
	if ((quote !== '"' && quote !== "'") || text[text.length - 1] !== quote) return undefined;
	return { text: unescapeText(text.slice(1, -1)) };
}

/** Expands a `#rgb`/`#rgba`/`#rrggbb`/`#rrggbbaa` literal into 0..1 components. */
function hexColorComponents(text: string): number[] {
	const hex = text.slice(1);
	const digits =
		hex.length <= 4
			? [...hex].map((digit) => digit + digit)
			: [hex.slice(0, 2), hex.slice(2, 4), hex.slice(4, 6), hex.slice(6, 8)];
	const components = digits.filter(Boolean).map((pair) => Number.parseInt(pair, 16) / 255);
	while (components.length < 3) components.push(0);
	if (components.length === 3) components.push(1);
	return components;
}

/** Parses the body of a `{…}` literal into key/value pairs. */
function parseDictionaryBody(body: string): { entries: DictionaryEntry[]; error?: string } {
	const entries: DictionaryEntry[] = [];
	let error: string | undefined;
	for (const part of splitTopLevel(body)) {
		const separator = part.indexOf(":");
		if (separator === -1) {
			error = `invalid dictionary entry: ${part}`;
			continue;
		}
		const key = parseVariant(part.slice(0, separator));
		const value = parseVariant(part.slice(separator + 1));
		error = error ?? key.error ?? value.error;
		entries.push({ key: key.value, value: value.value });
	}
	return { entries, error: error ? `invalid dictionary entry: ${error}` : undefined };
}

/** Parses one Godot variant literal. Unknown syntax yields a `Variant` value and an error. */
export function parseVariant(raw: string): ParseResult {
	const text = raw.trim();
	if (!text) return { value: { kind: "Variant", raw: text }, error: "empty value" };
	if (text === "null" || text === "nil") return { value: { kind: "Variant", raw: text } };
	if (text === "true" || text === "false")
		return { value: { kind: "bool", raw: text, number: text === "true" ? 1 : 0 } };

	if (/^[+-]?\d+$/.test(text)) return { value: { kind: "int", raw: text, number: Number.parseInt(text, 10) } };
	if (/^[+-]?(\d+\.\d*|\.\d+|\d+)([eE][+-]?\d+)?$/.test(text) && /[.eE]/.test(text)) {
		return { value: { kind: "float", raw: text, number: Number.parseFloat(text) } };
	}
	// `inf`, `-inf` and `nan` are float literals in Godot text resources.
	const special = SPECIAL_FLOATS[text];
	if (special !== undefined) return { value: { kind: "float", raw: text, number: special } };
	if (HEX_COLOR_RE.test(text)) {
		return { value: { kind: "Color", raw: text, components: hexColorComponents(text), hex: true } };
	}

	// `&"name"` is the Godot 4 spelling, `@"name"` the Godot 3 one.
	if (text.startsWith("&") || text.startsWith("@")) {
		const inner = parseQuoted(text.slice(1).trim());
		if (!inner) return { value: { kind: "Variant", raw: text }, error: `unparsable value: ${text}` };
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

	const reference = text.match(/^(Ext|Sub)Resource\(\s*(?:"([^"]*)"|(\d+))\s*\)$/);
	if (reference) {
		const kind = reference[1] === "Ext" ? "ExtResource" : "SubResource";
		const unquoted = reference[3] !== undefined;
		return { value: { kind, raw: text, referenceId: reference[2] ?? reference[3], unquoted } };
	}

	const typedArray = text.match(/^Array\[([^\]]*)\]\(([\s\S]*)\)$/);
	if (typedArray) {
		// Godot writes the value as `Array[T]([...])`; accept a bare list too.
		let body = typedArray[2].trim();
		if (body.startsWith("[") && body.endsWith("]")) body = body.slice(1, -1);
		const items = splitTopLevel(body).map((item) => parseVariant(item));
		const error = items.find((item) => item.error)?.error;
		return {
			value: {
				kind: "Array",
				raw: text,
				arrayType: typedArray[1].trim(),
				items: items.map((item) => item.value),
			},
			error: error ? `invalid array entry: ${error}` : undefined,
		};
	}

	const typedDictionary = text.match(/^Dictionary\[([^\]]*)\]\(([\s\S]*)\)$/);
	if (typedDictionary) {
		// Godot 4.4 writes `Dictionary[K, V]({...})`.
		const [keyType, valueType] = typedDictionary[1].split(",").map((part) => part.trim());
		let body = typedDictionary[2].trim();
		if (body.startsWith("{") && body.endsWith("}")) body = body.slice(1, -1);
		const { entries, error } = parseDictionaryBody(body);
		return {
			value: {
				kind: "Dictionary",
				raw: text,
				entries,
				dictionaryTypes: [keyType || "Variant", valueType || "Variant"],
			},
			error,
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
		const { entries, error } = parseDictionaryBody(text.slice(1, -1).trim());
		return { value: { kind: "Dictionary", raw: text, entries }, error };
	}

	const constructorMatch = text.match(/^([A-Za-z_][A-Za-z0-9_]*)\(([\s\S]*)\)$/);
	if (constructorMatch) {
		const name = constructorMatch[1];
		const args = splitTopLevel(constructorMatch[2]);
		if (PACKED_ARRAYS[name]) {
			// A lone quoted argument is a base64 payload (Godot writes those for
			// `PackedByteArray`); it is kept verbatim instead of being edited.
			if (args.length === 1 && parseQuoted(args[0])) {
				return { value: { kind: PACKED_ARRAYS[name], raw: text, typeName: name } };
			}
			const items = args.map((item) => parseVariant(item));
			const error = items.find((item) => item.error)?.error;
			return {
				value: {
					kind: PACKED_ARRAYS[name],
					raw: text,
					items: items.map((item) => item.value),
					typeName: name === PACKED_ARRAYS[name] ? undefined : name,
				},
				error: error ? `invalid array entry: ${error}` : undefined,
			};
		}
		if (name === "StringName") {
			const inner = parseQuoted(args[0] ?? "");
			if (!inner) return { value: { kind: "Variant", raw: text }, error: "invalid StringName" };
			return { value: { kind: "StringName", raw: text, text: inner.text, typeName: name } };
		}
		const descriptor = CONSTRUCTORS[name];
		if (descriptor) {
			if (name === "Color") {
				// `Color(code)`/`Color(r, g, b)` are valid GDScript; alpha defaults to 1.
				const code = parseQuoted(args[0] ?? "");
				if (code) return { value: { kind: "Color", raw: text, text: code.text } };
				const components = args.map((item) => Number(item));
				if (components.length === 3) components.push(1);
				if (components.length !== 4 || components.some((component) => Number.isNaN(component))) {
					return {
						value: { kind: "Color", raw: text, typeName: name },
						error: "expected 3 or 4 numeric components",
					};
				}
				return { value: { kind: "Color", raw: text, components } };
			}
			const components = args.map((item) => Number(item));
			if (
				components.length !== descriptor.components ||
				components.some((component) => Number.isNaN(component))
			) {
				return {
					value: { kind: descriptor.kind, raw: text, typeName: name === descriptor.kind ? undefined : name },
					error: `expected ${descriptor.components} numeric components`,
				};
			}
			return {
				value: {
					kind: descriptor.kind,
					raw: text,
					components,
					typeName: name === descriptor.kind ? undefined : name,
				},
			};
		}
		// `RID()`, `Signal("…")`, `Callable()` and `Object("Type", …)` carry no
		// editable structure; keep them verbatim instead of flagging them.
		if (OPAQUE_CONSTRUCTORS.has(name)) return { value: { kind: "Variant", raw: text, typeName: name } };
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
		case "bool":
			return value.number ? "true" : "false";
		case "int":
			return String(Math.trunc(value.number ?? 0));
		case "float": {
			const number = value.number ?? 0;
			// `inf`/`nan` keep the spelling the file uses.
			if (!Number.isFinite(number)) return value.raw.trim();
			return Number.isInteger(number) ? `${number}.0` : formatNumber(number);
		}
		case "String":
			return quote(value.text ?? "");
		case "StringName": {
			// Godot 3 files spell StringNames `StringName("…")`; keep that form.
			return value.typeName === "StringName"
				? `StringName(${quote(value.text ?? "")})`
				: `&${quote(value.text ?? "")}`;
		}
		case "NodePath":
			return `NodePath(${quote(value.text ?? "")})`;
		case "ExtResource":
		case "SubResource": {
			const prefix = value.kind === "ExtResource" ? "Ext" : "Sub";
			const id = value.referenceId ?? "";
			// Godot 3 leaves the id unquoted and padded: `ExtResource( 1 )`.
			return value.unquoted ? `${prefix}Resource( ${id} )` : `${prefix}Resource(${quote(id)})`;
		}
		case "Array": {
			const items = (value.items ?? []).map(formatVariant).join(", ");
			const literal = `[${items}]`;
			return value.arrayType ? `Array[${value.arrayType}](${literal})` : literal;
		}
		case "Dictionary": {
			const entries = (value.entries ?? [])
				.map((entry) => `${formatVariant(entry.key)}: ${formatVariant(entry.value)}`)
				.join(", ");
			const literal = `{${entries}}`;
			return value.dictionaryTypes ? `Dictionary[${value.dictionaryTypes.join(", ")}](${literal})` : literal;
		}
		case "Color": {
			// `Color("code")` keeps its string argument, `#rrggbb` its literal.
			if (value.text !== undefined) return `Color(${quote(value.text)})`;
			if (value.hex) return value.raw.trim();
			break;
		}
		default:
			break;
	}
	// Packed arrays keep the file's spelling (`PoolColorArray` vs `PackedColorArray`).
	if (value.kind in PACKED_ARRAYS) {
		if (!value.items) return value.raw.trim();
		return `${value.typeName ?? value.kind}(${value.items.map(formatVariant).join(", ")})`;
	}
	const components = value.components;
	if (components?.length) return `${value.typeName ?? value.kind}(${components.map(formatNumber).join(", ")})`;
	return value.raw.trim();
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
	// A value we could not classify may still be assignable: never guess.
	if (value.kind === "Variant") return true;
	if (expected === "Array") return value.kind === "Array" || value.kind in PACKED_ARRAYS;
	if (expected === "ExtResource") {
		return (
			value.kind === "ExtResource" || value.kind === "SubResource" || value.raw === "null" || value.raw === "nil"
		);
	}
	if (expected === "int") return value.kind === "int" || value.kind === "float";
	if (expected === "float") return value.kind === "float" || value.kind === "int";
	return value.kind === expected;
}
