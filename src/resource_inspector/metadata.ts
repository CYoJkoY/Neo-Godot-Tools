/**
 * Property metadata for the Resource Inspector.
 *
 * Metadata comes from three sources, in order of preference:
 *  1. the connected Godot language server (`textDocument/nativeSymbol`),
 *  2. the `@export` annotations of the resource's script (and shader uniforms),
 *  3. the properties already present in the `.tres` file and built-in schemas.
 */

import { PropertyEntry, ResourceDocument } from "./document.js";
import { componentCount, normalizeTypeName, parseVariant, VariantValue } from "./values.js";

export type PropertyMetadataSource = "lsp" | "script" | "file" | "builtin";

export interface PropertyMetadata {
	name: string;
	type: string;
	hint?: string;
	hintString?: string;
	/** A known literal default, never the current file value or an expression. */
	defaultValue?: string;
	/** A script initializer that cannot be evaluated safely without Godot. */
	defaultExpression?: string;
	category?: string;
	group?: string;
	source: PropertyMetadataSource;
}

export type WidgetKind =
	| "checkbox"
	| "number"
	| "text"
	| "textarea"
	| "enum"
	| "flags"
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
	/** Whole numbers only (`int` properties). */
	integer?: boolean;
	/** Whether this is a known concrete native class, not e.g. Texture2D/Script. */
	creatable?: boolean;
	min?: number;
	max?: number;
	step?: number;
	allowGreater?: boolean;
	allowLesser?: boolean;
	exponential?: boolean;
	hideSlider?: boolean;
	suffix?: string;
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

/**
 * Common built-in Godot resource properties used when the Godot Language Server
 * is not connected, so opening or creating standard resources and sub-resources
 * immediately exposes their key properties and widgets.
 */
const BUILTIN_CLASS_SCHEMAS: Record<string, Array<Omit<PropertyMetadata, "source">>> = {
	ShaderMaterial: [
		{ name: "shader", type: "Shader", defaultValue: "null" },
		{ name: "render_priority", type: "int", hint: "range", hintString: "-128, 127, 1", defaultValue: "0" },
	],
	Shader: [
		{ name: "code", type: "String", hint: "multiline", defaultValue: '""' },
	],
	CanvasItemMaterial: [
		{ name: "blend_mode", type: "int", hint: "enum", hintString: "Mix,Add,Sub,Mul,Premult Alpha", defaultValue: "0" },
		{ name: "light_mode", type: "int", hint: "enum", hintString: "Normal,Unshaded,Light Only", defaultValue: "0" },
		{ name: "particles_animation", type: "bool", defaultValue: "false" },
		{ name: "particles_anim_h_frames", type: "int", defaultValue: "1" },
		{ name: "particles_anim_v_frames", type: "int", defaultValue: "1" },
		{ name: "particles_anim_loop", type: "bool", defaultValue: "false" },
	],
	StandardMaterial3D: [
		{ name: "transparency", type: "int", hint: "enum", hintString: "Disabled,Alpha,Alpha Scissor,Alpha Hash,Depth Pre-Pass", defaultValue: "0" },
		{ name: "cull_mode", type: "int", hint: "enum", hintString: "Back,Front,Disabled", defaultValue: "0" },
		{ name: "shading_mode", type: "int", hint: "enum", hintString: "Per-Pixel,Unshaded,Per-Vertex", defaultValue: "1" },
		{ name: "albedo_color", type: "Color", defaultValue: "Color(1, 1, 1, 1)" },
		{ name: "albedo_texture", type: "Texture2D", defaultValue: "null" },
		{ name: "metallic", type: "float", hint: "range", hintString: "0, 1, 0.01", defaultValue: "0.0" },
		{ name: "metallic_specular", type: "float", hint: "range", hintString: "0, 1, 0.01", defaultValue: "0.5" },
		{ name: "roughness", type: "float", hint: "range", hintString: "0, 1, 0.01", defaultValue: "1.0" },
		{ name: "emission_enabled", type: "bool", defaultValue: "false" },
		{ name: "emission", type: "Color", defaultValue: "Color(0, 0, 0, 1)" },
		{ name: "emission_energy_multiplier", type: "float", defaultValue: "1.0" },
		{ name: "normal_enabled", type: "bool", defaultValue: "false" },
		{ name: "normal_texture", type: "Texture2D", defaultValue: "null" },
		{ name: "uv1_scale", type: "Vector3", defaultValue: "Vector3(1, 1, 1)" },
		{ name: "uv1_offset", type: "Vector3", defaultValue: "Vector3(0, 0, 0)" },
	],
	ORMMaterial3D: [
		{ name: "albedo_color", type: "Color", defaultValue: "Color(1, 1, 1, 1)" },
		{ name: "albedo_texture", type: "Texture2D", defaultValue: "null" },
		{ name: "orm_texture", type: "Texture2D", defaultValue: "null" },
		{ name: "emission_enabled", type: "bool", defaultValue: "false" },
		{ name: "emission", type: "Color", defaultValue: "Color(0, 0, 0, 1)" },
	],
	StyleBoxFlat: [
		{ name: "bg_color", type: "Color", defaultValue: "Color(0.6, 0.6, 0.6, 1)" },
		{ name: "draw_center", type: "bool", defaultValue: "true" },
		{ name: "border_width_left", type: "int", defaultValue: "0" },
		{ name: "border_width_top", type: "int", defaultValue: "0" },
		{ name: "border_width_right", type: "int", defaultValue: "0" },
		{ name: "border_width_bottom", type: "int", defaultValue: "0" },
		{ name: "border_color", type: "Color", defaultValue: "Color(0.8, 0.8, 0.8, 1)" },
		{ name: "corner_radius_top_left", type: "int", defaultValue: "0" },
		{ name: "corner_radius_top_right", type: "int", defaultValue: "0" },
		{ name: "corner_radius_bottom_right", type: "int", defaultValue: "0" },
		{ name: "corner_radius_bottom_left", type: "int", defaultValue: "0" },
		{ name: "shadow_color", type: "Color", defaultValue: "Color(0, 0, 0, 0.6)" },
		{ name: "shadow_size", type: "int", defaultValue: "0" },
		{ name: "shadow_offset", type: "Vector2", defaultValue: "Vector2(0, 0)" },
		{ name: "content_margin_left", type: "float", defaultValue: "-1.0" },
		{ name: "content_margin_top", type: "float", defaultValue: "-1.0" },
		{ name: "content_margin_right", type: "float", defaultValue: "-1.0" },
		{ name: "content_margin_bottom", type: "float", defaultValue: "-1.0" },
	],
	StyleBoxTexture: [
		{ name: "texture", type: "Texture2D", defaultValue: "null" },
		{ name: "modulate_color", type: "Color", defaultValue: "Color(1, 1, 1, 1)" },
		{ name: "region_rect", type: "Rect2", defaultValue: "Rect2(0, 0, 0, 0)" },
	],
	StyleBoxLine: [
		{ name: "color", type: "Color", defaultValue: "Color(0, 0, 0, 1)" },
		{ name: "thickness", type: "int", defaultValue: "1" },
		{ name: "vertical", type: "bool", defaultValue: "false" },
	],
	Gradient: [
		{ name: "interpolation_mode", type: "int", hint: "enum", hintString: "Linear,Constant,Cubic", defaultValue: "0" },
		{ name: "offsets", type: "PackedFloat32Array", defaultValue: "PackedFloat32Array(0, 1)" },
		{ name: "colors", type: "PackedColorArray", defaultValue: "PackedColorArray(0, 0, 0, 1, 1, 1, 1, 1)" },
	],
	GradientTexture1D: [
		{ name: "gradient", type: "Gradient", defaultValue: "null" },
		{ name: "width", type: "int", defaultValue: "256" },
		{ name: "use_hdr", type: "bool", defaultValue: "false" },
	],
	GradientTexture2D: [
		{ name: "gradient", type: "Gradient", defaultValue: "null" },
		{ name: "width", type: "int", defaultValue: "64" },
		{ name: "height", type: "int", defaultValue: "64" },
		{ name: "fill", type: "int", hint: "enum", hintString: "Linear,Radial,Square", defaultValue: "0" },
		{ name: "fill_from", type: "Vector2", defaultValue: "Vector2(0, 0)" },
		{ name: "fill_to", type: "Vector2", defaultValue: "Vector2(1, 0)" },
	],
	LabelSettings: [
		{ name: "font", type: "Font", defaultValue: "null" },
		{ name: "font_size", type: "int", defaultValue: "16" },
		{ name: "font_color", type: "Color", defaultValue: "Color(1, 1, 1, 1)" },
		{ name: "outline_size", type: "int", defaultValue: "0" },
		{ name: "outline_color", type: "Color", defaultValue: "Color(1, 1, 1, 1)" },
		{ name: "shadow_size", type: "int", defaultValue: "1" },
		{ name: "shadow_color", type: "Color", defaultValue: "Color(0, 0, 0, 0)" },
		{ name: "shadow_offset", type: "Vector2", defaultValue: "Vector2(1, 1)" },
	],
	AtlasTexture: [
		{ name: "atlas", type: "Texture2D", defaultValue: "null" },
		{ name: "region", type: "Rect2", defaultValue: "Rect2(0, 0, 0, 0)" },
		{ name: "margin", type: "Rect2", defaultValue: "Rect2(0, 0, 0, 0)" },
		{ name: "filter_clip", type: "bool", defaultValue: "false" },
	],
	BoxShape3D: [
		{ name: "size", type: "Vector3", defaultValue: "Vector3(1, 1, 1)" },
	],
	SphereShape3D: [
		{ name: "radius", type: "float", defaultValue: "0.5" },
	],
	CapsuleShape3D: [
		{ name: "radius", type: "float", defaultValue: "0.5" },
		{ name: "height", type: "float", defaultValue: "2.0" },
	],
	CylinderShape3D: [
		{ name: "radius", type: "float", defaultValue: "0.5" },
		{ name: "height", type: "float", defaultValue: "2.0" },
	],
	RectangleShape2D: [
		{ name: "size", type: "Vector2", defaultValue: "Vector2(20, 20)" },
	],
	CircleShape2D: [
		{ name: "radius", type: "float", defaultValue: "10.0" },
	],
	CapsuleShape2D: [
		{ name: "radius", type: "float", defaultValue: "10.0" },
		{ name: "height", type: "float", defaultValue: "30.0" },
	],
	BoxMesh: [
		{ name: "size", type: "Vector3", defaultValue: "Vector3(1, 1, 1)" },
		{ name: "material", type: "Material", defaultValue: "null" },
	],
	SphereMesh: [
		{ name: "radius", type: "float", defaultValue: "0.5" },
		{ name: "height", type: "float", defaultValue: "1.0" },
		{ name: "material", type: "Material", defaultValue: "null" },
	],
	PlaneMesh: [
		{ name: "size", type: "Vector2", defaultValue: "Vector2(2, 2)" },
		{ name: "material", type: "Material", defaultValue: "null" },
	],
	QuadMesh: [
		{ name: "size", type: "Vector2", defaultValue: "Vector2(1, 1)" },
		{ name: "material", type: "Material", defaultValue: "null" },
	],
	FastNoiseLite: [
		{ name: "noise_type", type: "int", hint: "enum", hintString: "Simplex,SimplexSmooth,Cellular,Perlin,ValueCubic,Value", defaultValue: "0" },
		{ name: "seed", type: "int", defaultValue: "0" },
		{ name: "frequency", type: "float", defaultValue: "0.01" },
		{ name: "fractal_octaves", type: "int", defaultValue: "5" },
	],
	NoiseTexture2D: [
		{ name: "width", type: "int", defaultValue: "512" },
		{ name: "height", type: "int", defaultValue: "512" },
		{ name: "seamless", type: "bool", defaultValue: "false" },
		{ name: "color_ramp", type: "Gradient", defaultValue: "null" },
		{ name: "noise", type: "FastNoiseLite", defaultValue: "null" },
	],
	Environment: [
		{ name: "background_mode", type: "int", hint: "enum", hintString: "Clear Color,Custom Color,Sky,Canvas,Keep,Camera Feed", defaultValue: "0" },
		{ name: "background_color", type: "Color", defaultValue: "Color(0, 0, 0, 1)" },
		{ name: "ambient_light_source", type: "int", hint: "enum", hintString: "Background,Disabled,Color,Sky", defaultValue: "0" },
		{ name: "ambient_light_color", type: "Color", defaultValue: "Color(0, 0, 0, 1)" },
		{ name: "ambient_light_energy", type: "float", defaultValue: "1.0" },
		{ name: "glow_enabled", type: "bool", defaultValue: "false" },
		{ name: "ssao_enabled", type: "bool", defaultValue: "false" },
		{ name: "fog_enabled", type: "bool", defaultValue: "false" },
	],
};

/** Returns built-in property metadata for known Godot resource classes. */
export function builtinClassProperties(resourceType: string): PropertyMetadata[] {
	const schema = BUILTIN_CLASS_SCHEMAS[resourceType];
	if (!schema) return [];
	return schema.map((entry) => ({ ...entry, source: "builtin" as const }));
}

/** Returns a valid Godot text-resource default value for `type`. */
export function defaultValueForType(type: string): string {
	const trimmed = type.trim();
	const typedArray = trimmed.match(/^Array\[([^\]]*)\]$/);
	if (typedArray) return `Array[${typedArray[1]}]([])`;
	const normalized = normalizeTypeName(trimmed);
	switch (normalized) {
		case "bool": return "false";
		case "int": return "0";
		case "float": return "0.0";
		case "String": return '""';
		case "StringName": return '&""';
		case "NodePath": return 'NodePath("")';
		case "Color": return "Color(0, 0, 0, 1)";
		case "Vector2": return "Vector2(0, 0)";
		case "Vector2i": return "Vector2i(0, 0)";
		case "Vector3": return "Vector3(0, 0, 0)";
		case "Vector3i": return "Vector3i(0, 0, 0)";
		case "Vector4": return "Vector4(0, 0, 0, 0)";
		case "Vector4i": return "Vector4i(0, 0, 0, 0)";
		case "Rect2": return "Rect2(0, 0, 0, 0)";
		case "Rect2i": return "Rect2i(0, 0, 0, 0)";
		case "Quaternion":
		case "Quat": return "Quaternion(0, 0, 0, 1)";
		case "Plane": return "Plane(0, 0, 0, 0)";
		case "AABB":
		case "Rect3": return "AABB(0, 0, 0, 0, 0, 0)";
		case "Basis":
		case "Matrix3": return "Basis(1, 0, 0, 0, 1, 0, 0, 0, 1)";
		case "Transform2D":
		case "Matrix32": return "Transform2D(1, 0, 0, 1, 0, 0)";
		case "Transform3D":
		case "Transform": return "Transform3D(1, 0, 0, 0, 1, 0, 0, 0, 1, 0, 0, 0)";
		case "Projection": return "Projection(1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1)";
		case "Array": return "[]";
		case "Dictionary": return "{}";
		default:
			if (normalized.startsWith("Packed") || normalized.startsWith("Pool")) return `${normalized}()`;
			return "null";
	}
}

const EXPORT_ANNOTATION_RE = /^[ \t]*@export([A-Za-z_]*)\s*(?:\(([^)]*)\))?/;
const GODOT3_EXPORT_RE = /^[ \t]*export\s*(?:\(([^)]*)\))?\s+(?=var\b)/;
const EXPORT_GROUPS = new Set(["category", "group", "subgroup", "tool_button"]);

function stripQuotes(value: string): string {
	const trimmed = value.trim();
	if ((trimmed.startsWith('"') && trimmed.endsWith('"')) || (trimmed.startsWith("'") && trimmed.endsWith("'"))) return trimmed.slice(1, -1);
	return trimmed;
}

/** Strips a `# ...` comment that appears outside string literals. */
function stripInlineComment(line: string): string {
	let quoted: string | undefined;
	for (let index = 0; index < line.length; index++) {
		const char = line[index];
		if (quoted) {
			if (char === "\\") index++;
			else if (char === quoted) quoted = undefined;
			continue;
		}
		if (char === '"' || char === "'") {
			quoted = char;
			continue;
		}
		if (char === "#") return line.slice(0, index).trimEnd();
	}
	return line;
}

/** Strips a trailing `: ...` getter/setter clause at bracket depth 0. */
function stripAccessorClause(text: string): string {
	let depth = 0;
	let quoted: string | undefined;
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
		else if (char === ":" && depth === 0) return text.slice(0, index).trim();
	}
	return text.trim();
}

/** Parses `var <name> [: <type>] [:= | = <default>]` with optional getter/setter suffix. */
function parseVariableDeclaration(line: string): { name: string; declaredType?: string; defaultValue?: string } | undefined {
	const clean = stripInlineComment(line).trim();
	const header = clean.match(/^(?:static\s+)?var\s+([A-Za-z_][A-Za-z0-9_]*)\s*(.*)$/);
	if (!header) return undefined;
	const name = header[1];
	const tail = header[2].trim();
	if (!tail) return { name };

	if (tail.startsWith(":=")) {
		const value = stripAccessorClause(tail.slice(2));
		return { name, defaultValue: value || undefined };
	}

	if (tail.startsWith("=")) {
		const value = stripAccessorClause(tail.slice(1));
		return { name, defaultValue: value || undefined };
	}

	if (tail.startsWith(":")) {
		const afterColon = tail.slice(1).trim();
		let depth = 0;
		let quoted: string | undefined;
		for (let index = 0; index < afterColon.length; index++) {
			const char = afterColon[index];
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
			else if (char === "=" && depth === 0) {
				const declaredType = afterColon.slice(0, index).replace(/:$/, "").trim();
				const defaultValue = stripAccessorClause(afterColon.slice(index + 1));
				return {
					name,
					declaredType: declaredType || undefined,
					defaultValue: defaultValue || undefined,
				};
			} else if (char === ":" && depth === 0) {
				const declaredType = afterColon.slice(0, index).trim();
				return { name, declaredType: declaredType || undefined };
			}
		}
		return { name, declaredType: afterColon || undefined };
	}

	return undefined;
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
 * Reads `@export` (Godot 4) and `export` (Godot 3) declarations from a GDScript
 * source and returns the exported property metadata (type, hint, hint string and
 * default value).
 */
export function parseScriptExports(source: string): PropertyMetadata[] {
	const lines = source.split(/\r?\n/);
	const result: PropertyMetadata[] = [];
	let annotation: { name: string; args?: string; legacy?: boolean } | undefined;
	let currentCategory: string | undefined;
	let currentGroup: string | undefined;

	for (const line of lines) {
		const trimmed = stripInlineComment(line).trim();
		if (!trimmed) continue;
		let rest = trimmed;
		let current = annotation;

		const exportMatch = trimmed.match(EXPORT_ANNOTATION_RE);
		if (exportMatch) {
			// `@export_range`/`@export_enum` are spelled with an underscore; drop it so the
			// hint name matches the annotation.
			const name = exportMatch[1].replace(/^_/, "");
			const groupArgs = splitArguments(exportMatch[2]).map(stripQuotes);
			if (name === "category") {
				currentCategory = groupArgs[0] || undefined;
				currentGroup = undefined;
				current = undefined;
			} else if (name === "group" || name === "subgroup") {
				currentGroup = groupArgs[0] || undefined;
				current = undefined;
			} else if (EXPORT_GROUPS.has(name)) {
				current = undefined;
			} else {
				current = { name, args: exportMatch[2] };
			}
			rest = trimmed.slice(exportMatch[0].length).trim();
		} else {
			const legacyMatch = trimmed.match(GODOT3_EXPORT_RE);
			if (legacyMatch) {
				current = { name: "", args: legacyMatch[1], legacy: true };
				rest = trimmed.slice(legacyMatch[0].length).trim();
			}
		}

		if (!rest || rest.startsWith("@")) {
			// The declaration is on a following line (or another annotation follows).
			annotation = current;
			continue;
		}
		annotation = undefined;
		if (!current) continue;
		const variable = parseVariableDeclaration(rest);
		if (!variable) continue;
		const { name, declaredType, defaultValue } = variable;
		const args = splitArguments(current.args);
		const metadata: PropertyMetadata = {
			name,
			type: declaredType?.trim() || inferTypeFromValue(defaultValue ?? ""),
			defaultValue: defaultValue?.trim(),
			source: "script",
		};
		if (currentCategory) metadata.category = currentCategory;
		if (currentGroup) metadata.group = currentGroup;

		if (current.legacy && args.length > 0) {
			const first = args[0].trim();
			const restArgs = args.slice(1);
			if ((first === "int" || first === "float") && restArgs.length > 0 && restArgs.every((arg) => !Number.isNaN(Number(arg)))) {
				metadata.type = first;
				metadata.hint = "range";
				metadata.hintString = restArgs.join(", ");
			} else if (restArgs.length > 0 && restArgs.every((arg) => /^["']/.test(arg.trim()))) {
				metadata.type = first === "String" ? "String" : "int";
				metadata.hint = "enum";
				metadata.hintString = restArgs.map(stripQuotes).join(",");
			} else if (first === "String" && restArgs[0]?.trim() === "MULTILINE") {
				metadata.type = "String";
				metadata.hint = "multiline";
			} else if (first === "Array" && restArgs[0]) {
				metadata.type = `Array[${restArgs[0].trim()}]`;
			} else if (!declaredType && /^[A-Za-z_][A-Za-z0-9_]*$/.test(first)) {
				metadata.type = first;
			}
		}

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
		// A declaration without an initializer has a known type default. A
		// constant, preload() or other expression does not: never write GDScript
		// expressions into a .tres file when reverting an override.
		if (defaultValue === undefined) {
			const type = normalizeTypeName(metadata.type);
			// An unresolved name might be an enum, not a nullable resource class.
			// Its type placeholder is not evidence of the actual script default.
			const knownType = NON_RESOURCE_TYPES.has(type) || Object.hasOwn(BUILTIN_CLASS_SCHEMAS, type) || KNOWN_NULL_TYPES.has(type);
			metadata.defaultValue = knownType ? defaultValueForType(metadata.type) : undefined;
		}
		else if (parseVariant(defaultValue).error) {
			metadata.defaultExpression = defaultValue;
			metadata.defaultValue = undefined;
		}
		result.push(metadata);
	}
	return result;
}

/**
 * Parses `uniform` declarations from a Godot shader (`Shader` sub-resource or
 * `.gdshader` file) and maps them onto `ShaderMaterial` property metadata.
 */
export function parseShaderUniforms(
	shaderSource: string | undefined,
	prefix: "shader_parameter/" | "shader_param/" = "shader_parameter/",
): PropertyMetadata[] {
	if (!shaderSource) return [];
	const withoutComments = shaderSource
		.replace(/\/\*[\s\S]*?\*\//g, "")
		.replace(/\/\/[^\n]*/g, "");
	const results: PropertyMetadata[] = [];
	const uniformRe = /\buniform\s+([A-Za-z_][A-Za-z0-9_]*)\s+([A-Za-z_][A-Za-z0-9_]*)\s*(?::\s*([^=;]+))?\s*(?:=\s*([^;]+))?\s*;/g;

	for (const match of withoutComments.matchAll(uniformRe)) {
		const [, rawType, name, rawHint, rawDefault] = match;
		const hintText = rawHint?.trim() ?? "";
		const isColor = /\b(?:source_color|hint_color)\b/.test(hintText);
		const rangeMatch = hintText.match(/\bhint_range\s*\(([^)]*)\)/);

		let type = "Variant";
		switch (rawType) {
			case "bool": type = "bool"; break;
			case "int":
			case "uint": type = "int"; break;
			case "float": type = "float"; break;
			case "vec2": type = "Vector2"; break;
			case "ivec2":
			case "uvec2": type = "Vector2i"; break;
			case "vec3": type = isColor ? "Color" : "Vector3"; break;
			case "ivec3":
			case "uvec3": type = "Vector3i"; break;
			case "vec4": type = isColor ? "Color" : "Vector4"; break;
			case "ivec4":
			case "uvec4": type = "Vector4i"; break;
			case "sampler2D":
			case "sampler2DArray":
			case "sampler3D":
			case "samplerCube": type = "Texture2D"; break;
			default: break;
		}

		const metadata: PropertyMetadata = {
			name: `${prefix}${name}`,
			type,
			defaultValue: normalizeShaderDefault(rawDefault?.trim(), type),
			category: "Shader Parameters",
			source: "script",
		};
		if (rangeMatch) {
			metadata.hint = "range";
			metadata.hintString = rangeMatch[1]
				.split(",")
				.map((part) => normalizeShaderFloatLiteral(part.trim()))
				.join(", ");
		}
		results.push(metadata);
	}
	return results;
}

function normalizeShaderFloatLiteral(token: string): string {
	if (/^[+-]?\d+\.$/.test(token)) return `${token}0`;
	if (/^[+-]?\.\d+$/.test(token)) return token.replace(/^([+-]?)\./, "$10.");
	return token;
}

function normalizeShaderDefault(rawDefault: string | undefined, godotType: string): string | undefined {
	if (!rawDefault) return undefined;
	const normalized = normalizeShaderFloatLiteral(rawDefault);
	if (godotType === "float" && /^[+-]?\d+$/.test(normalized)) return `${normalized}.0`;
	const vecMatch = normalized.match(/^[iu]?vec([234])\s*\(([^)]*)\)$/);
	if (vecMatch) {
		const count = Number(vecMatch[1]);
		const parts = vecMatch[2].split(",").map((part) => Number(normalizeShaderFloatLiteral(part.trim())));
		if (parts.every((part) => Number.isFinite(part))) {
			const expanded = parts.length === 1 ? Array.from({ length: count }, () => parts[0]) : parts;
			if (godotType === "Color") {
				while (expanded.length < 4) expanded.push(expanded.length === 3 ? 1 : 0);
				return `Color(${expanded.slice(0, 4).join(", ")})`;
			}
			return `${godotType}(${expanded.join(", ")})`;
		}
	}
	return normalized;
}

/** Reads the `extends` clause of a GDScript source, if any. */
export function parseScriptBaseClass(source: string | undefined): string | undefined {
	if (!source) return undefined;
	for (const line of source.split(/\r?\n/)) {
		const trimmed = stripInlineComment(line).trim();
		if (!trimmed) continue;
		const match = trimmed.match(/^extends\s+(?:"([^"]+)"|'([^']+)'|([A-Za-z_][\w.]*))/);
		if (match) return match[1] ?? match[2] ?? match[3];
		if (trimmed.startsWith("class_name") || trimmed.startsWith("@") || trimmed.startsWith("tool")) continue;
		if (/^(func|var|signal|enum|const|export)\b/.test(trimmed)) break;
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
	default_value?: string;
}

/**
 * Merges the available metadata sources. Properties present in the file are
 * always exposed so the panel can edit them, even without any metadata.
 */
export function collectPropertyMetadata(options: {
	document: ResourceDocument;
	scriptSource?: string;
	shaderSource?: string;
	lspProperties?: readonly LspPropertyInfo[];
}): PropertyMetadata[] {
	const merged = new Map<string, PropertyMetadata>();
	for (const property of [...BUILTIN_RESOURCE_PROPERTIES, ...builtinClassProperties(options.document.resourceType)]) {
		merged.set(property.name, { ...property });
	}
	for (const property of options.lspProperties ?? []) {
		const fallback = merged.get(property.name);
		merged.set(property.name, {
			...fallback,
			name: property.name,
			type: property.type && property.type !== "Variant" ? property.type : fallback?.type ?? "Variant",
			hint: property.hint ?? fallback?.hint,
			hintString: property.hint_string ?? fallback?.hintString,
			defaultValue: property.default_value ?? fallback?.defaultValue,
			source: "lsp",
		});
	}
	const scriptProperties = parseScriptExports(options.scriptSource ?? "");
	const usesLegacyPrefix = options.document.format === "2" || options.document.properties.some((property) => property.name.startsWith("shader_param/"));
	const shaderProperties = parseShaderUniforms(options.shaderSource, usesLegacyPrefix ? "shader_param/" : "shader_parameter/");
	for (const property of [...scriptProperties, ...shaderProperties]) {
		const existing = merged.get(property.name);
		// LSP supplies authoritative types, but nativeSymbol often supplies no
		// hints or defaults. Keep the actual script/schema default underneath it.
		merged.set(property.name, existing?.source === "lsp" ? {
			...property,
			type: existing.type !== "Variant" ? existing.type : property.type,
			hint: existing.hint ?? property.hint,
			hintString: existing.hintString ?? property.hintString,
			source: "lsp",
		} : property);
	}
	for (const property of propertyMetadataFromDocument(options.document)) {
		const existing = merged.get(property.name);
		if (!existing) merged.set(property.name, property);
		else if (existing.type === "Variant") merged.set(property.name, { ...existing, type: property.type });
		// The file tells us the current value, NOT the default. Unknown native
		// defaults must remain unknown, even when a property is serialized.
	}
	return [...merged.values()];
}

/** Only literal defaults can be compared or safely written to a .tres file. */
export function knownDefaultValue(metadata: PropertyMetadata | undefined): string | undefined {
	if (!metadata || metadata.source === "file" || metadata.defaultValue === undefined) return undefined;
	return parseVariant(metadata.defaultValue).error ? undefined : metadata.defaultValue;
}

export interface RangeHint {
	min?: number;
	max?: number;
	step?: number;
	allowGreater?: boolean;
	allowLesser?: boolean;
	exponential?: boolean;
	hideSlider?: boolean;
	suffix?: string;
}

/** Decodes positional bounds/step and Godot's optional range flags. */
export function parseRangeHint(hintString: string | undefined): RangeHint {
	const args = splitArguments(hintString).map(stripQuotes);
	const numberAt = (index: number) => args[index]?.trim() && Number.isFinite(Number(args[index])) ? Number(args[index]) : undefined;
	const result: RangeHint = { min: numberAt(0), max: numberAt(1), step: numberAt(2) };
	if (result.step !== undefined && result.step <= 0) result.step = undefined;
	if (result.min !== undefined && result.max !== undefined && result.min > result.max) {
		result.min = undefined;
		result.max = undefined;
	}
	for (const flag of args.slice(2)) {
		if (flag === "or_greater") result.allowGreater = true;
		else if (flag === "or_less") result.allowLesser = true;
		else if (flag === "exp") result.exponential = true;
		else if (flag === "hide_slider") result.hideSlider = true;
		else if (flag.startsWith("suffix:")) result.suffix = flag.slice("suffix:".length);
	}
	return result;
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
		return { kind: hint === "flags" ? "flags" : "enum", options, elementType: type === "String" ? "String" : "int" };
	}
	if (type === "bool" || value.kind === "bool") return { kind: "checkbox" };
	if (type === "NodePath" || value.kind === "NodePath") return { kind: "nodepath" };
	if (type === "Color" || value.kind === "Color") return { kind: "color" };
	const components = componentCount(type) ?? value.components?.length;
	if (components && components > 1) return { kind: "vector", components, ...(/^(?:Vector[234]i|Rect2i)$/.test(type) ? { integer: true, step: 1 } : {}) };
	if (type === "int" || type === "float" || value.kind === "int" || value.kind === "float") {
		const range = parseRangeHint(hint === "range" ? metadata?.hintString : undefined);
		const widget: WidgetSpec = { kind: "number", ...range, step: range.step ?? (type === "int" ? 1 : undefined) };
		// Integer properties must not end up with `3.7` written into the file.
		if (type === "int") widget.integer = true;
		return widget;
	}
	if (type === "Array" || value.kind === "Array" || value.kind.startsWith("Packed")) {
		const arrayType = metadata?.type.match(/^Array\[([^\]]*)\]$/)?.[1];
		const elementType = arrayType ?? (value.kind.startsWith("Packed") ? value.kind.replace(/^Packed|Array$/g, "").toLowerCase() : undefined);
		return { kind: "array", elementType, components: elementType ? componentCount(elementType) : undefined };
	}
	if (type === "Dictionary" || value.kind === "Dictionary") return { kind: "dictionary" };
	if (value.kind === "ExtResource" || value.kind === "SubResource" || isResourceMetadata(type)) {
		return { kind: "resource", creatable: type === "Resource" || Object.hasOwn(BUILTIN_CLASS_SCHEMAS, type) };
	}
	if (hint === "multiline" || (value.kind === "String" && (value.raw.includes("\n") || value.text?.includes("\n")))) {
		return { kind: "textarea" };
	}
	return { kind: "text" };
}

const KNOWN_NULL_TYPES = new Set([
	"Object", "Resource", "Script", "Texture", "Texture2D", "Texture3D", "Material", "Mesh", "Font", "PackedScene", "Node", "StyleBox", "Noise",
]);

/** Built-in types that are edited with a dedicated widget instead of a resource picker. */
const NON_RESOURCE_TYPES = new Set([
	"Variant", "bool", "int", "float", "String", "StringName", "NodePath", "Color",
	"Vector2", "Vector2i", "Vector3", "Vector3i", "Vector4", "Vector4i", "Rect2", "Rect2i",
	"Transform2D", "Transform3D", "Projection", "Basis", "Quaternion", "Plane", "AABB",
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
