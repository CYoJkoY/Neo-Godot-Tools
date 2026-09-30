import { strict as assert } from "node:assert";
import { describe, it } from "node:test";
import { parseResourceDocument } from "./document.js";
import {
	collectPropertyMetadata,
	enumOptions,
	inferTypeFromValue,
	parseRangeHint,
	parseScriptExports,
	widgetForProperty,
} from "./metadata.js";
import { parseVariant } from "./values.js";

const SCRIPT = `extends Resource
class_name Hero

@export_category("Stats")
@export var health: int = 100
@export_range(0.0, 10.0, 0.5) var speed: float = 3.0
@export_enum("Idle", "Run", "Jump") var state: int = 0
@export_multiline var bio: String = ""
@export var sprite: Texture2D
@export var target: NodePath
@export var gradient: Gradient
@export var levels: Array[Vector2] = []
@export var loot: Dictionary = {}

var hidden := 1

func helper() -> void:
	pass
`;

describe("script export metadata", () => {
	it("reads exported properties and their defaults", () => {
		const exports = parseScriptExports(SCRIPT);
		assert.deepEqual(exports.map((property) => property.name), ["health", "speed", "state", "bio", "sprite", "target", "gradient", "levels", "loot"]);
		assert.equal(exports[0].type, "int");
		assert.equal(exports[0].defaultValue, "100");
		assert.equal(exports[1].type, "float");
		assert.equal(exports[1].hint, "range");
		assert.equal(exports[1].defaultValue, "3.0");
	});

	it("ignores non-exported variables and export groups", () => {
		const exports = parseScriptExports(SCRIPT);
		assert.ok(!exports.some((property) => property.name === "hidden"));
		assert.ok(!exports.some((property) => property.name === "helper"));
	});

	it("keeps enum, resource and node path hints", () => {
		const byName = new Map(parseScriptExports(SCRIPT).map((property) => [property.name, property]));
		assert.equal(byName.get("state")?.hint, "enum");
		assert.deepEqual(enumOptions(byName.get("state")?.hintString), ["Idle", "Run", "Jump"]);
		assert.equal(byName.get("sprite")?.type, "Texture2D");
		assert.equal(byName.get("target")?.type, "NodePath");
		assert.equal(byName.get("levels")?.type, "Array[Vector2]");
		assert.equal(byName.get("loot")?.type, "Dictionary");
	});

	it("decodes range hints and infers untyped defaults", () => {
		assert.deepEqual(parseRangeHint("0.0, 10.0, 0.5"), { min: 0, max: 10, step: 0.5 });
		assert.deepEqual(parseRangeHint(undefined), { min: undefined, max: undefined, step: undefined });
		assert.equal(inferTypeFromValue("3.0"), "float");
		assert.equal(inferTypeFromValue('"text"'), "String");
		assert.equal(inferTypeFromValue("true"), "bool");
		assert.equal(inferTypeFromValue('ExtResource("1_a")'), "Resource");
	});
});

describe("inspector widgets", () => {
	it("chooses type-aware widgets", () => {
		const value = (raw: string) => parseVariant(raw).value;
		assert.equal(widgetForProperty({ name: "a", type: "bool", source: "script" }, value("true")).kind, "checkbox");
		assert.equal(widgetForProperty({ name: "a", type: "Color", source: "script" }, value("Color(1, 1, 1, 1)")).kind, "color");
		assert.equal(widgetForProperty({ name: "a", type: "NodePath", source: "script" }, value('NodePath("A")')).kind, "nodepath");
		assert.equal(widgetForProperty({ name: "a", type: "Gradient", source: "script" }, value("null")).kind, "resource");
		assert.equal(widgetForProperty({ name: "a", type: "Texture2D", source: "script" }, value('ExtResource("1_a")')).kind, "resource");
		assert.equal(widgetForProperty({ name: "a", type: "Dictionary", source: "script" }, value("{}")).kind, "dictionary");
		assert.equal(widgetForProperty({ name: "a", type: "String", source: "script", hint: "multiline" }, value('""')).kind, "textarea");
		assert.equal(widgetForProperty({ name: "a", type: "String", source: "script" }, value('"x"')).kind, "text");
	});

	it("groups vector-like values and reports their component count", () => {
		const widget = widgetForProperty({ name: "a", type: "Transform3D", source: "script" }, parseVariant("Transform3D(1, 0, 0, 0, 1, 0, 0, 0, 1, 0, 0, 0)").value);
		assert.equal(widget.kind, "vector");
		assert.equal(widget.components, 12);
		assert.equal(widgetForProperty({ name: "a", type: "Vector2", source: "script" }, parseVariant("Vector2(1, 2)").value).components, 2);
	});

	it("applies range bounds to numbers and decodes enums", () => {
		const widget = widgetForProperty({ name: "a", type: "float", source: "script", hint: "range", hintString: "1, 5, 0.5" }, parseVariant("2.0").value);
		assert.deepEqual(widget, { kind: "number", step: 0.5, min: 1, max: 5 });
		const enumWidget = widgetForProperty({ name: "a", type: "int", source: "script", hint: "enum", hintString: "Idle,Run" }, parseVariant("0").value);
		assert.equal(enumWidget.kind, "enum");
		assert.deepEqual(enumWidget.options, ["Idle", "Run"]);
	});

	it("carries the element type into array widgets", () => {
		const widget = widgetForProperty({ name: "a", type: "Array[Vector2]", source: "script" }, parseVariant("[]").value);
		assert.equal(widget.kind, "array");
		assert.equal(widget.elementType, "Vector2");
		assert.equal(widget.components, 2);
	});
});

describe("property metadata merging", () => {
	const text = `[gd_resource type="Resource" script_class="Hero" format=3]

[ext_resource type="Script" path="res://hero.gd" id="1_script"]

[resource]
script = ExtResource("1_script")
health = 40
speed = 9.0
`;

	it("combines built-in, script and file metadata", () => {
		const document = parseResourceDocument(text);
		const metadata = collectPropertyMetadata({ document, scriptSource: SCRIPT });
		const byName = new Map(metadata.map((property) => [property.name, property]));
		assert.equal(byName.get("resource_local_to_scene")?.source, "builtin");
		assert.equal(byName.get("health")?.source, "script");
		assert.equal(byName.get("health")?.type, "int");
		// The script default wins over the current value, so revert can restore it.
		assert.equal(byName.get("health")?.defaultValue, "100");
		assert.equal(byName.get("speed")?.hint, "range");
	});

	it("prefers language server metadata when connected", () => {
		const document = parseResourceDocument(text);
		const metadata = collectPropertyMetadata({
			document,
			scriptSource: SCRIPT,
			lspProperties: [{ name: "health", type: "float", hint: "range", hint_string: "0, 100" }],
		});
		const health = metadata.find((property) => property.name === "health");
		assert.equal(health?.source, "lsp");
		assert.equal(health?.type, "float");
	});

	it("falls back to the properties stored in the file", () => {
		const document = parseResourceDocument(text);
		const metadata = collectPropertyMetadata({ document });
		const health = metadata.find((property) => property.name === "health");
		assert.equal(health?.source, "file");
		assert.equal(health?.type, "int");
		const script = metadata.find((property) => property.name === "script");
		assert.equal(script?.type, "Script");
	});
});
