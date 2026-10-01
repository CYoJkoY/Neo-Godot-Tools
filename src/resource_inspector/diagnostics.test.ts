import { strict as assert } from "node:assert";
import { describe, it } from "node:test";
import { validateResourceDocument, validateResourceText } from "./diagnostics.js";
import { parseResourceDocument } from "./document.js";
import { PropertyMetadata, collectPropertyMetadata } from "./metadata.js";

const SCRIPT = `extends Resource
class_name Hero

@export var health: int = 100
@export var speed: float = 3.0
@export var texture: Texture2D
@export var gradient: Gradient
`;

function documentWith(body: string) {
	return parseResourceDocument(`[gd_resource type="Resource" script_class="Hero" format=3]

[ext_resource type="Script" path="res://hero.gd" id="1_script"]

[resource]
script = ExtResource("1_script")
${body}
`);
}

function metadataFor(text: string): PropertyMetadata[] {
	return collectPropertyMetadata({ document: parseResourceDocument(text), scriptSource: SCRIPT });
}

/** Metadata as the Godot language server reports it: every property of a class. */
function engineMetadata(names: string[]): PropertyMetadata[] {
	return names.map((name) => ({ name, type: "Variant", source: "lsp" as const }));
}

describe("resource diagnostics", () => {
	it("accepts a consistent document", () => {
		const text = `[gd_resource type="Resource" script_class="Hero" format=3]

[ext_resource type="Script" path="res://hero.gd" id="1_script"]

[sub_resource type="Gradient" id="Gradient_1"]
colors = PackedColorArray(1, 0, 0, 1)

[resource]
script = ExtResource("1_script")
health = 100
speed = 3.0
gradient = SubResource("Gradient_1")
`;
		assert.deepEqual(validateResourceText(text, metadataFor(text)), []);
	});

	it("reports dangling resource ids", () => {
		const text = `[gd_resource type="Resource" script_class="Hero" format=3]

[resource]
texture = ExtResource("9_missing")
gradient = SubResource("Nope")
`;
		const diagnostics = validateResourceDocument(parseResourceDocument(text), metadataFor(text));
		assert.ok(
			diagnostics.some(
				(diagnostic) =>
					diagnostic.severity === "error" &&
					diagnostic.message.includes("Dangling ExtResource id '9_missing'"),
			),
		);
		assert.ok(diagnostics.some((diagnostic) => diagnostic.message.includes("Dangling SubResource id 'Nope'")));
	});

	it("reports unparsable values and points at the property line", () => {
		const text = `[gd_resource type="Resource" format=3]

[resource]
size = Vector2(1, 2, 3)
broken = @@@
`;
		const diagnostics = validateResourceDocument(parseResourceDocument(text));
		const size = diagnostics.find((diagnostic) => diagnostic.message.includes("'size'"));
		assert.ok(size);
		assert.equal(size.line, 3);
		assert.ok(diagnostics.some((diagnostic) => diagnostic.message.includes("'broken'")));
	});

	it("reports type mismatches against script metadata", () => {
		const text = `[gd_resource type="Resource" script_class="Hero" format=3]

[resource]
health = 100
speed = "fast"
`;
		const diagnostics = validateResourceDocument(parseResourceDocument(text), metadataFor(text));
		assert.ok(
			diagnostics.some(
				(diagnostic) =>
					diagnostic.severity === "error" &&
					diagnostic.message.includes("Type mismatch for 'speed': expected float"),
			),
		);
		assert.ok(!diagnostics.some((diagnostic) => diagnostic.message.includes("'health'")));
	});

	it("warns about unknown properties only for engine-provided metadata", () => {
		const text = `[gd_resource type="Resource" format=3]

[resource]
health = 100
ghost = 1
`;
		const document = parseResourceDocument(text);
		// The language server knows every property the type has, so `ghost` is a typo.
		const withEngine = validateResourceDocument(document, engineMetadata(["health"]), { complete: true });
		const unknown = withEngine.find((diagnostic) => diagnostic.message.includes("Unknown property 'ghost'"));
		assert.ok(unknown);
		assert.equal(unknown.severity, "warning");
		assert.equal(unknown.line, 4);
	});

	it("does not report unknown properties from partial metadata", () => {
		const text = `[gd_resource type="Resource" script_class="Hero" format=3]

[resource]
health = 100
ghost = 1
`;
		// Script exports describe the script's own properties only; the engine
		// properties of whatever the script extends would all look "unknown", so
		// this metadata is never treated as authoritative.
		assert.deepEqual(validateResourceDocument(parseResourceDocument(text), metadataFor(text)), []);
	});

	it("does not report unknown properties without any metadata", () => {
		const text = `[gd_resource type="Resource" format=3]

[resource]
anything = 1
`;
		assert.deepEqual(validateResourceDocument(parseResourceDocument(text)), []);
	});

	it("accepts every literal form Godot loads", () => {
		const text = `[gd_resource type="Resource" format=3]

[ext_resource type="Script" path="res://hero.gd" id="1_script"]

[ext_resource type="Texture2D" path="res://icon.png" id="1"]

[resource]
script = ExtResource("1_script")
local_to_scene = false
name = "Hero"
label = StringName("hero")
path = NodePath("Sprite2D")
legacy_reference = ExtResource( 1 )
legacy_pool = PoolColorArray(1, 0, 0, 1)
legacy_pool2 = PoolVector2Array(0, 0, 16, 0)
legacy_transform = Transform(1, 0, 0, 0, 1, 0, 0, 0, 1, 0, 0, 0)
legacy_quat = Quat(0, 0, 0, 1)
legacy_rect3 = Rect3(0, 0, 0, 1, 1, 1)
typed_array = Array[Vector2]([Vector2(1, 2)])
typed_dictionary = Dictionary[String, int]({"a": 1})
hex_color = #ff8800
nothing = nil
infinity = inf
empty = []
nested = [[1, 2], [3, 4]]
`;
		assert.deepEqual(validateResourceText(text, metadataFor(text)), []);
	});

	it("keeps reporting real problems", () => {
		const text = `[gd_resource type="Resource" script_class="Hero" format=3]

[resource]
texture = ExtResource("9_missing")
broken = @@@
speed = "fast"
`;
		const diagnostics = validateResourceDocument(parseResourceDocument(text), metadataFor(text));
		assert.ok(
			diagnostics.some(
				(diagnostic) =>
					diagnostic.severity === "error" &&
					diagnostic.message.includes("Dangling ExtResource id '9_missing'"),
			),
		);
		assert.ok(diagnostics.some((diagnostic) => diagnostic.message.includes("Unparsable value for 'broken'")));
		assert.ok(diagnostics.some((diagnostic) => diagnostic.message.includes("Type mismatch for 'speed'")));
		// The unparsable value is opaque, so no type mismatch is guessed for it.
		assert.ok(!diagnostics.some((diagnostic) => diagnostic.message.includes("Type mismatch for 'broken'")));
	});
});
