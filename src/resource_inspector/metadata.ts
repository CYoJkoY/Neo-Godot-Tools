/**
 * Property metadata for the Resource Inspector.
 *
 * Metadata comes from three sources, in order of preference:
 *  1. the connected Godot language server (`textDocument/nativeSymbol`),
 *  2. the `@export` annotations of the resource's script,
 *  3. the properties already present in the `.tres` file.
 */

import { PropertyEntry, ResourceDocument } from "./document.js";
import { componentCount, normalizeTypeName, parseVariant, VariantValue } from "./values.js";

export type PropertyMetadataSource = "lsp" | "script" | "file" | "builtin";

export interface PropertyMetadata {
	name: string;
	type: string;
	hint?: string;
	hintString?: string;
	defaultValue?: string;
	source: PropertyMetadataSource;
}

export type WidgetKind =
	| "checkbox"
	| "number"
	| "text"
	| "textarea"
	| "enum"
	| "color"
	| "vector"
	| "resource"
	| "array"
	| "dictionary"
	| "nodepath";

export interface WidgetSpec {
	kind: WidgetKind;
	/** Number of grouped numeric fields for vector-like values. */
	components?: number;
	min?: number;
	max?: number;
	step?: number;
	/** Enum/flags options decoded from `hint_string`. */
	options?: string[];
	elementType?: string;
}

/** Properties every `Resource` exposes in Godot's inspector. */
export const BUILTIN_RESOURCE_PROPERTIES: PropertyMetadata[] = [
	{ name: "script", type: "Script", defaultValue: "null", source: "builtin" },
	{ name: "resource_local_to_scene", type: "bool", defaultValue: "false", source: "builtin" },
	{ name: "resource_name", type: "String", defaultValue: '""', source: "builtin" },
];

const EXPORT_ANNOTATION_RE = /^[ \t]*@export([A-Za-z_]*)\s*(?:\(([^)]*)\))?/;
const EXPORT_GROUPS = new Set(["category", "group", "subgroup", "tool_button"]);
const VARIABLE_RE = /^[ \t]*(?:static\s+)?var\s+([A-Za-z_][A-Za-z0-9_]*)\s*(?::\s*([^=]+?))?\s*(?::?=\s*(.*))?$/;

function stripQuotes(value: string): string {
	const trimmed = value.trim();
	if ((trimmed.startsWith('"') && trimmed.endsWith('"')) || (trimmed.startsWith("'") && trimmed.endsWith("'"))) return trimmed.slice(1, -1);
	return trimmed;
}

function splitArguments(text: string | undefined): string[] {
	if (!text) return [];
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
		else if (char === "," && depth === 0) { parts.push(text.slice(start, index).trim()); start = index + 1; }
	}
	const tail = text.slice(start).trim();
	if (tail) parts.push(tail);
	return parts;
}

/** Infers a Godot type from a literal default value. */
export function inferTypeFromValue(value: string): string {
	const parsed = parseVariant(value);
	if (parsed.value.kind === "Variant") return "Variant";
	if (parsed.value.kind === "ExtResource" || parsed.value.kind === "SubResource") return "Resource";
	return parsed.value.kind;
}

/**
 * Reads `@export` annotations from a GDScript source and returns the exported
 * property metadata (type, hint, hint string and default value).
 */
export function parseScriptExports(source: string): PropertyMetadata[] {
	const lines = source.split(/\r?\n/);
	const result: PropertyMetadata[] = [];
	let annotation: { name: string; args?: string } | undefined;
	for (const line of lines) {
		const trimmed = line.trim();
		if (!trimmed || trimmed.startsWith("#")) continue;
		let rest = trimmed;
		let current = annotation;
		const exportMatch = trimmed.match(EXPORT_ANNOTATION_RE);
		if (exportMatch) {
			// `@export_range`/`@export_enum` are spelled with an underscore; drop it so the
			// hint name matches the annotation.
			const name = exportMatch[1].replace(/^_/, "");
			// `@export_category`/`@export_group` organise the inspector; they do not
			// export a property themselves.
			current = EXPORT_GROUPS.has(name) ? undefined : { name, args: exportMatch[2] };
			rest = trimmed.slice(exportMatch[0].length).trim();
		}
		if (!rest || rest.startsWith("@")) {
			// The declaration is on a following line (or another annotation follows).
			annotation = current;
			continue;
		}
		annotation = undefined;
		if (!current) continue;
		const variable = rest.match(VARIABLE_RE);
		if (!variable) continue;
		const [, name, declaredType, defaultValue] = variable;
		const args = splitArguments(current.args);
		const metadata: PropertyMetadata = {
			name,
			type: declaredType?.trim() || inferTypeFromValue(defaultValue ?? ""),
			defaultValue: defaultValue?.trim(),
			source: "script",
		};
		switch (current.name) {
			case "range": {
				metadata.hint = "range";
				metadata.hintString = args.join(", ");
				break;
			}
			case "enum": {
				metadata.hint = "enum";
				metadata.hintString = args.map(stripQuotes).join(",");
				metadata.type = declaredType?.trim() || "int";
				break;
			}
			case "flags": {
				metadata.hint = "flags";
				metadata.hintString = args.map(stripQuotes).join(",");
				break;
			}
			case "multiline": {
				metadata.hint = "multiline";
				metadata.type = declaredType?.trim() || "String";
				break;
			}
			case "color_no_alpha": {
				metadata.type = "Color";
				break;
			}
			case "file":
			case "dir":
			case "global_file":
			case "global_dir": {
				metadata.hint = current.name;
				metadata.hintString = args.map(stripQuotes).join(",");
				metadata.type = "String";
				break;
			}
			case "node_path": {
				metadata.type = "NodePath";
				break;
			}
			default: break;
		}
		result.push(metadata);
	}
	return result;
}

/** Reads the `extends` clause of a GDScript source, if any. */
export function parseScriptBaseClass(source: string | undefined): string | undefined {
	if (!source) return undefined;
	for (const line of source.split(/\r?\n/)) {
		const trimmed = line.trim();
		if (!trimmed || trimmed.startsWith("#")) continue;
		const match = trimmed.match(/^extends\s+([A-Za-z_][\w.]*)/);
		if (match) return match[1];
		if (trimmed.startsWith("class_name") || trimmed.startsWith("@")) continue;
		if (/^(func|var|signal|enum|const)\b/.test(trimmed)) break;
	}
	return undefined;
}

/** Infers metadata for the properties that are present in the file. */
export function propertyMetadataFromDocument(document: ResourceDocument): PropertyMetadata[] {
	const values = new Map<string, VariantValue>();
	for (const property of document.properties) values.set(property.name, property.value);
	for (const subResource of document.subResources) {
		for (const property of subResource.properties) values.set(`${subResource.id}.${property.name}`, property.value);
	}
	return document.properties.map((property) => ({
		name: property.name,
		type: valueTypeName(property.value, document),
		defaultValue: property.valueText,
		source: "file" as const,
	}));
}

function valueTypeName(value: VariantValue, document: ResourceDocument): string {
	if (value.kind === "ExtResource") {
		const resource = document.extResources.find((entry) => entry.id === value.referenceId);
		return resource?.type ?? "Resource";
	}
	if (value.kind === "SubResource") {
		const resource = document.subResources.find((entry) => entry.id === value.referenceId);
		return resource?.type ?? "Resource";
	}
	if (value.kind === "Variant") return "Variant";
	return value.kind;
}

export interface LspPropertyInfo {
	name: string;
	type?: string;
	hint?: string;
	hint_string?: string;
}

/**
 * Merges the available metadata sources. Properties present in the file are
 * always exposed so the panel can edit them, even without any metadata.
 */
export function collectPropertyMetadata(options: {
	document: ResourceDocument;
	scriptSource?: string;
	lspProperties?: readonly LspPropertyInfo[];
}): PropertyMetadata[] {
	const merged = new Map<string, PropertyMetadata>();
	for (const property of BUILTIN_RESOURCE_PROPERTIES) merged.set(property.name, property);
	for (const property of options.lspProperties ?? []) {
		merged.set(property.name, {
			name: property.name,
			type: property.type ?? "Variant",
			hint: property.hint,
			hintString: property.hint_string,
			source: "lsp",
		});
	}
	if (options.scriptSource) {
		for (const property of parseScriptExports(options.scriptSource)) {
			if (!merged.has(property.name) || merged.get(property.name)?.source !== "lsp") merged.set(property.name, property);
		}
	}
	for (const property of propertyMetadataFromDocument(options.document)) {
		const existing = merged.get(property.name);
		if (!existing) merged.set(property.name, property);
		else if (existing.defaultValue === undefined) existing.defaultValue = property.defaultValue;
	}
	return [...merged.values()];
}

/** Decodes `@export_range(min, max, step)` style hint strings. */
export function parseRangeHint(hintString: string | undefined): { min?: number; max?: number; step?: number } {
	const args = splitArguments(hintString).map((argument) => stripQuotes(argument));
	const numbers = args.filter((argument) => argument !== "" && !Number.isNaN(Number(argument))).map(Number);
	return { min: numbers[0], max: numbers[1], step: numbers[2] };
}

export function enumOptions(hintString: string | undefined): string[] | undefined {
	if (!hintString) return undefined;
	const values = splitArguments(hintString).map(stripQuotes).filter((value) => value.length > 0);
	return values.length ? values : undefined;
}

/** Chooses the widget used to edit a property in the panel. */
export function widgetForProperty(metadata: PropertyMetadata | undefined, value: VariantValue): WidgetSpec {
	const type = normalizeTypeName(metadata?.type ?? "Variant");
	const hint = metadata?.hint;
	if (hint === "enum" || hint === "flags") {
		const options = enumOptions(metadata?.hintString) ?? [];
		return { kind: "enum", options, elementType: "int" };
	}
	if (type === "bool" || value.kind === "bool") return { kind: "checkbox" };
	if (type === "NodePath" || value.kind === "NodePath") return { kind: "nodepath" };
	if (type === "Color" || value.kind === "Color") return { kind: "color" };
	const components = componentCount(type) ?? value.components?.length;
	if (components && components > 1) return { kind: "vector", components };
	if (type === "int" || type === "float" || value.kind === "int" || value.kind === "float") {
		const range = parseRangeHint(metadata?.hintString);
		return { kind: "number", step: range.step ?? (type === "int" ? 1 : undefined), min: range.min, max: range.max };
	}
	if (type === "Array" || value.kind === "Array" || value.kind.startsWith("Packed")) {
		const arrayType = metadata?.type.match(/^Array\[([^\]]*)\]$/)?.[1];
		const elementType = arrayType ?? (value.kind.startsWith("Packed") ? value.kind.replace(/^Packed|Array$/g, "").toLowerCase() : undefined);
		return { kind: "array", elementType, components: elementType ? componentCount(elementType) : undefined };
	}
	if (type === "Dictionary" || value.kind === "Dictionary") return { kind: "dictionary" };
	if (value.kind === "ExtResource" || value.kind === "SubResource" || isResourceMetadata(type)) {
		return { kind: "resource" };
	}
	if (hint === "multiline") return { kind: "textarea" };
	return { kind: "text" };
}

/** Built-in types that are edited with a dedicated widget instead of a resource picker. */
const NON_RESOURCE_TYPES = new Set([
	"Variant", "bool", "int", "float", "String", "StringName", "NodePath", "Color",
	"Vector2", "Vector2i", "Vector3", "Vector3i", "Vector4", "Vector4i", "Rect2", "Rect2i",
	"Transform2D", "Transform3D", "Basis", "Quaternion", "Plane", "AABB",
	"Array", "Dictionary", "PackedByteArray", "PackedInt32Array", "PackedInt64Array",
	"PackedFloat32Array", "PackedFloat64Array", "PackedStringArray", "PackedVector2Array",
	"PackedVector3Array", "PackedVector4Array", "PackedColorArray",
]);

/** Anything that is not a built-in value type is stored as a (sub-)resource reference. */
function isResourceMetadata(type: string): boolean {
	if (type === "Object" || type === "Resource") return true;
	return !NON_RESOURCE_TYPES.has(normalizeTypeName(type));
}

/** Sub-resource types referenced by a property (used by the resource picker). */
export function referencedSubResourceType(document: ResourceDocument, entry: PropertyEntry): string | undefined {
	if (entry.value.kind !== "SubResource") return undefined;
	return document.subResources.find((resource) => resource.id === entry.value.referenceId)?.type;
}

