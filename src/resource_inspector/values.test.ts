import { strict as assert } from "node:assert";
import { describe, it } from "node:test";
import {
	formatVariant,
	normalizeTypeName,
	parseVariant,
	valueMatchesType,
	variantKindForType,
	withComponents,
	withItems,
} from "./values.js";

describe("resource inspector variant values", () => {
	it("parses primitives", () => {
		assert.equal(parseVariant("true").value.kind, "bool");
		assert.equal(parseVariant("false").value.kind, "bool");
		assert.deepEqual(parseVariant("42").value.number, 42);
		assert.equal(parseVariant("42").value.kind, "int");
		assert.equal(parseVariant("2.5").value.kind, "float");
		assert.equal(parseVariant("2.5").value.number, 2.5);
		assert.equal(parseVariant('"hello"').value.text, "hello");
		assert.equal(parseVariant("null").value.kind, "Variant");
	});

	it("parses StringName, NodePath and resource references", () => {
		const stringName = parseVariant('&"Idle"').value;
		assert.equal(stringName.kind, "StringName");
		assert.equal(stringName.text, "Idle");

		const nodePath = parseVariant('NodePath("../Target")').value;
		assert.equal(nodePath.kind, "NodePath");
		assert.equal(nodePath.text, "../Target");

		const ext = parseVariant('ExtResource("1_ab")').value;
		assert.equal(ext.kind, "ExtResource");
		assert.equal(ext.referenceId, "1_ab");

		const sub = parseVariant('SubResource("Sub_1")').value;
		assert.equal(sub.kind, "SubResource");
		assert.equal(sub.referenceId, "Sub_1");
	});

	it("parses vector-like constructors into components", () => {
		assert.deepEqual(parseVariant("Vector2(1, 2)").value.components, [1, 2]);
		assert.deepEqual(parseVariant("Vector2i(-3, 4)").value.components, [-3, 4]);
		assert.deepEqual(parseVariant("Vector3(1, 2, 3)").value.components, [1, 2, 3]);
		assert.deepEqual(parseVariant("Vector4i(1, 0, 0, 1)").value.components, [1, 0, 0, 1]);
		assert.deepEqual(parseVariant("Rect2(0, 0, 8, 8)").value.components, [0, 0, 8, 8]);
		assert.deepEqual(parseVariant("Basis(1, 0, 0, 0, 1, 0, 0, 0, 1)").value.components?.length, 9);
		assert.deepEqual(parseVariant("Transform2D(0, 0, 1, 1, 0, 0)").value.components?.length, 6);
		assert.deepEqual(parseVariant("Transform3D(1, 0, 0, 0, 1, 0, 0, 0, 1, 0, 0, 0)").value.components?.length, 12);
		assert.deepEqual(parseVariant("AABB(0, 0, 0, 1, 1, 1)").value.components?.length, 6);
		assert.deepEqual(parseVariant("Quaternion(0, 0, 0, 1)").value.components, [0, 0, 0, 1]);
		assert.deepEqual(parseVariant("Plane(0, 1, 0, 0)").value.components, [0, 1, 0, 0]);
	});

	it("parses Color and arrays", () => {
		const color = parseVariant("Color(1, 0.5, 0, 1)").value;
		assert.equal(color.kind, "Color");
		assert.deepEqual(color.components, [1, 0.5, 0, 1]);

		const array = parseVariant('["a", "b"]').value;
		assert.equal(array.kind, "Array");
		assert.deepEqual(array.items?.map((item) => item.text), ["a", "b"]);

		const typed = parseVariant('Array[Vector2]([Vector2(1, 2), Vector2(3, 4)])').value;
		assert.equal(typed.arrayType, "Vector2");
		assert.deepEqual(typed.items?.map((item) => item.components), [[1, 2], [3, 4]]);

		const packed = parseVariant("PackedFloat32Array(0.5, 1.5)").value;
		assert.equal(packed.kind, "PackedFloat32Array");
		assert.deepEqual(packed.items?.map((item) => item.number), [0.5, 1.5]);
	});

	it("parses dictionaries", () => {
		const dictionary = parseVariant('{"speed": 12, "name": &"Hero"}').value;
		assert.equal(dictionary.kind, "Dictionary");
		assert.equal(dictionary.entries?.length, 2);
		assert.equal(dictionary.entries?.[0].key.text, "speed");
		assert.equal(dictionary.entries?.[0].value.number, 12);
		assert.equal(dictionary.entries?.[1].value.kind, "StringName");
	});

	it("reports errors for malformed values", () => {
		assert.ok(parseVariant("").error);
		assert.ok(parseVariant("Vector2(1, 2, 3)").error);
		assert.ok(parseVariant("&not-a-string").error);
		assert.ok(parseVariant("SomethingElse(1)").error);
		assert.ok(parseVariant("not a value").error);
	});

	it("formats values back to Godot syntax", () => {
		assert.equal(formatVariant(parseVariant("true").value), "true");
		assert.equal(formatVariant(parseVariant("3").value), "3");
		assert.equal(formatVariant(parseVariant("3.0").value), "3.0");
		assert.equal(formatVariant(parseVariant('"hi"').value), '"hi"');
		assert.equal(formatVariant(parseVariant('&"hi"').value), '&"hi"');
		assert.equal(formatVariant(parseVariant('NodePath("a/b")').value), 'NodePath("a/b")');
		assert.equal(formatVariant(parseVariant('ExtResource("2_x")').value), 'ExtResource("2_x")');
		assert.equal(formatVariant(parseVariant("Vector3(1, 2, 3)").value), "Vector3(1, 2, 3)");
		assert.equal(formatVariant(parseVariant('["a", 2]').value), '["a", 2]');
		assert.equal(formatVariant(parseVariant('Array[int]([1, 2])').value), "Array[int]([1, 2])");
		assert.equal(formatVariant(parseVariant('{"a": 1}').value), '{"a": 1}');
		assert.equal(formatVariant(parseVariant("PackedStringArray(\"a\", \"b\")").value), 'PackedStringArray("a", "b")');
	});

	it("round-trips values without changing their text", () => {
		const samples = [
			"true", "-12", "0.5", "3.0", '"text"', '&"Name"', 'NodePath("A/B")',
			'ExtResource("1_abc")', 'SubResource("Sub_2")', "Vector2(1, 2)", "Vector2i(0, -1)",
			"Vector3(0.5, 0.25, 1)", "Rect2(0, 0, 4, 4)", "Color(1, 0.5, 0.25, 1)",
			"Transform2D(0, 0, 1, 1, 0, 0)", "AABB(0, 0, 0, 1, 1, 1)", "Basis(1, 0, 0, 0, 1, 0, 0, 0, 1)",
			"Quaternion(0, 0, 0, 1)", "Plane(0, 1, 0, 0)", '["a", "b"]', '{"k": 1}',
			"PackedFloat32Array(0.5, 1.5)", 'PackedStringArray("x")', 'Array[Vector2]([Vector2(1, 2)])',
		];
		for (const sample of samples) {
			const parsed = parseVariant(sample);
			assert.equal(parsed.error, undefined, `unexpected error for ${sample}`);
			assert.equal(formatVariant(parsed.value), sample, `round-trip failed for ${sample}`);
		}
	});

	it("regenerates raw text when components or items change", () => {
		const vector = withComponents("Vector2", [4, 5]);
		assert.equal(vector.raw, "Vector2(4, 5)");
		const items = withItems("Array", [parseVariant("1").value, parseVariant('"two"').value]);
		assert.equal(items.raw, '[1, "two"]');
		const typed = withItems("Array", [parseVariant("Vector2(1, 2)").value], "Vector2");
		assert.equal(typed.raw, "Array[Vector2]([Vector2(1, 2)])");
	});

	it("maps Godot type names onto widgets and validates assignments", () => {
		assert.equal(variantKindForType("bool"), "bool");
		assert.equal(variantKindForType("float"), "float");
		assert.equal(variantKindForType("Vector2"), "Vector2");
		assert.equal(variantKindForType("Array[Vector2]"), "Array");
		assert.equal(normalizeTypeName("Array[NodePath]"), "Array");
		assert.equal(normalizeTypeName("int"), "int");

		assert.ok(valueMatchesType(parseVariant("true").value, "bool"));
		assert.ok(!valueMatchesType(parseVariant("1").value, "bool"));
		assert.ok(valueMatchesType(parseVariant("1").value, "float"));
		assert.ok(valueMatchesType(parseVariant("Vector2(1, 2)").value, "Vector2"));
		assert.ok(valueMatchesType(parseVariant('ExtResource("1_a")').value, "Texture2D"));
		assert.ok(valueMatchesType(parseVariant("null").value, "Texture2D"));
		assert.ok(!valueMatchesType(parseVariant("4").value, "Vector2"));
		assert.ok(valueMatchesType(parseVariant("anything(1)").value, "Variant"));
	});
});
