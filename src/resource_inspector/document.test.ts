import { strict as assert } from "node:assert";
import { describe, it } from "node:test";
import {
	applyResourceEdits,
	createDocumentParseCache,
	parseResourceDocument,
	resourceReference,
	rewriteReferences,
	uniqueExtResourceId,
	uniqueSubResourceId,
} from "./document.js";

const SOURCE = `[gd_resource type="Resource" script_class="Hero" load_steps=3 format=3 uid="uid://abc"]

[ext_resource type="Script" path="res://hero.gd" id="1_script"]

[sub_resource type="Gradient" id="Gradient_1"]
colors = PackedColorArray(1, 0, 0, 1, 0, 1, 0, 1)

[resource]
script = ExtResource("1_script")
# keep this comment
name = &"Hero"
speed = 3.0
gradient = SubResource("Gradient_1")
`;

describe("resource document parsing", () => {
	it("reads the header and every section", () => {
		const document = parseResourceDocument(SOURCE);
		assert.equal(document.resourceType, "Resource");
		assert.equal(document.scriptClass, "Hero");
		assert.equal(document.format, "3");
		assert.equal(document.uid, "uid://abc");
		assert.equal(document.loadSteps, "3");
		assert.equal(document.extResources.length, 1);
		assert.deepEqual(document.extResources[0], {
			id: "1_script",
			type: "Script",
			path: "res://hero.gd",
			uid: undefined,
			line: 2,
			endLine: 2,
		});
		assert.equal(document.subResources.length, 1);
		assert.equal(document.subResources[0].id, "Gradient_1");
		assert.equal(document.subResources[0].type, "Gradient");
		assert.equal(document.subResources[0].properties[0].name, "colors");
		assert.deepEqual(
			document.properties.map((property) => property.name),
			["script", "name", "speed", "gradient"],
		);
		assert.equal(document.properties[2].value.kind, "float");
		assert.equal(document.properties[3].value.kind, "SubResource");
	});

	it("handles multi-line values and missing optional header attributes", () => {
		const text = `[gd_resource type="Resource" format=2]

[sub_resource type="Animation" id="Animation_1"]
tracks = [{
"keys": [1, 2]
}]

[resource]
animation = SubResource("Animation_1")
`;
		const document = parseResourceDocument(text);
		assert.equal(document.scriptClass, undefined);
		assert.equal(document.uid, undefined);
		const property = document.subResources[0].properties[0];
		assert.equal(property.name, "tracks");
		assert.ok(property.valueText.includes("\n"));
		assert.equal(property.value.kind, "Array");
		assert.equal(document.properties[0].value.kind, "SubResource");
	});
});

describe("resource document editing", () => {
	it("replaces only the edited property line", () => {
		const result = applyResourceEdits(SOURCE, [{ kind: "setProperty", name: "speed", value: "4.5" }]);
		assert.equal(result.text.replace("speed = 4.5", "speed = 3.0"), SOURCE);
		assert.ok(result.text.includes("# keep this comment"));
		assert.ok(result.text.includes('[gd_resource type="Resource" script_class="Hero"'));
	});

	it("keeps the original line endings", () => {
		const windows = SOURCE.replace(/\n/g, "\r\n");
		const result = applyResourceEdits(windows, [{ kind: "setProperty", name: "speed", value: "4.5" }]);
		assert.ok(result.text.includes("\r\n"));
		assert.ok(!/[^\r]\n/.test(result.text));
	});

	it("inserts a new property into the [resource] section", () => {
		const result = applyResourceEdits(SOURCE, [{ kind: "setProperty", name: "health", value: "10" }]);
		assert.ok(result.text.includes("[resource]\nhealth = 10\n"));
	});

	it("reverts to a default value or removes the property", () => {
		const withDefault = applyResourceEdits(SOURCE, [
			{ kind: "revertProperty", name: "speed", defaultValue: "1.0" },
		]);
		assert.ok(withDefault.text.includes("speed = 1.0"));
		const withoutDefault = applyResourceEdits(SOURCE, [{ kind: "revertProperty", name: "speed" }]);
		assert.ok(!withoutDefault.text.includes("speed"));
		assert.ok(withoutDefault.text.includes('name = &"Hero"'));
	});

	it("adds a sub-resource with a unique id", () => {
		const result = applyResourceEdits(SOURCE, [
			{ kind: "addSubResource", type: "Gradient", properties: { colors: "PackedColorArray()" } },
		]);
		assert.deepEqual(result.createdIds, ["Gradient_2"]);
		assert.ok(
			result.text.includes('[sub_resource type="Gradient" id="Gradient_2"]\ncolors = PackedColorArray()\n'),
		);
		assert.ok(result.text.indexOf("Gradient_2") < result.text.indexOf("[resource]"));
		// The new block is separated from its neighbours by a single blank line.
		assert.ok(!result.text.includes("\n\n\n"));
	});

	it("duplicates a sub-resource without touching references to the original", () => {
		const result = applyResourceEdits(SOURCE, [{ kind: "duplicateSubResource", id: "Gradient_1" }]);
		assert.deepEqual(result.createdIds, ["Gradient_2"]);
		assert.ok(
			result.text.includes(
				'[sub_resource type="Gradient" id="Gradient_2"]\ncolors = PackedColorArray(1, 0, 0, 1, 0, 1, 0, 1)',
			),
		);
		assert.ok(result.text.includes('gradient = SubResource("Gradient_1")'));
		assert.ok(!result.text.includes("\n\n\n"));
	});

	it("renames a sub-resource and rewrites its references", () => {
		const result = applyResourceEdits(SOURCE, [
			{ kind: "renameSubResource", id: "Gradient_1", newId: "Gradient_9" },
		]);
		assert.ok(result.text.includes('[sub_resource type="Gradient" id="Gradient_9"]'));
		assert.ok(result.text.includes('gradient = SubResource("Gradient_9")'));
		assert.ok(!result.text.includes("Gradient_1"));
	});

	it("deletes a sub-resource and drops its references", () => {
		const result = applyResourceEdits(SOURCE, [{ kind: "deleteSubResource", id: "Gradient_1" }]);
		assert.ok(!result.text.includes("[sub_resource"));
		assert.ok(result.text.includes("gradient = null"));
		assert.ok(result.text.includes('[resource]\nscript = ExtResource("1_script")'));
	});

	it("adds an external resource with a Godot-style header", () => {
		const result = applyResourceEdits(SOURCE, [
			{ kind: "addExtResource", type: "Texture2D", path: "res://icon.svg", uid: "uid://icon" },
		]);
		assert.deepEqual(result.createdIds, ["2_res"]);
		assert.ok(
			result.text.includes('[ext_resource type="Texture2D" uid="uid://icon" path="res://icon.svg" id="2_res"]'),
		);
		assert.ok(!result.text.includes("\n\n\n"));
		// The new resource is inserted after the existing ones, before the sub-resources.
		assert.ok(result.text.indexOf("2_res") < result.text.indexOf("[sub_resource"));
	});

	it("applies several edits in order", () => {
		const result = applyResourceEdits(SOURCE, [
			{ kind: "addSubResource", type: "Gradient" },
			{ kind: "setProperty", name: "gradient", value: 'SubResource("Gradient_2")' },
		]);
		assert.deepEqual(result.createdIds, ["Gradient_2"]);
		assert.ok(result.text.includes('gradient = SubResource("Gradient_2")'));
		const reparsed = parseResourceDocument(result.text);
		assert.equal(reparsed.subResources.length, 2);
	});

	it("edits a sub-resource property by target", () => {
		const result = applyResourceEdits(SOURCE, [
			{ kind: "setProperty", name: "colors", target: "Gradient_1", value: "PackedColorArray(0, 0, 0, 1)" },
		]);
		assert.equal(
			result.text,
			SOURCE.replace(
				"colors = PackedColorArray(1, 0, 0, 1, 0, 1, 0, 1)",
				"colors = PackedColorArray(0, 0, 0, 1)",
			),
		);
	});

	it("adds and reverts a missing sub-resource property", () => {
		const added = applyResourceEdits(SOURCE, [
			{ kind: "setProperty", name: "interpolation_mode", target: "Gradient_1", value: "1" },
		]);
		assert.ok(added.text.includes("colors = PackedColorArray(1, 0, 0, 1, 0, 1, 0, 1)\ninterpolation_mode = 1"));
		const reverted = applyResourceEdits(added.text, [
			{ kind: "revertProperty", name: "interpolation_mode", target: "Gradient_1" },
		]);
		assert.ok(!reverted.text.includes("interpolation_mode"));
	});

	it("ignores edits aimed at unknown sub-resources", () => {
		const result = applyResourceEdits(SOURCE, [
			{ kind: "setProperty", name: "colors", target: "Missing", value: "1" },
		]);
		assert.equal(result.text, SOURCE);
	});

	it("generates unique ids", () => {
		assert.equal(uniqueSubResourceId("Gradient", ["Gradient_1", "Gradient_2"]), "Gradient_3");
		assert.equal(uniqueSubResourceId("Gradient", []), "Gradient_1");
		assert.equal(uniqueExtResourceId(["1_script", "2_res"]), "3_res");
		assert.equal(uniqueExtResourceId([]), "1_res");
	});

	it("continues after the largest ID, including numeric and mixed ID styles", () => {
		assert.equal(uniqueExtResourceId(["1_script", "7_texture", "3_res"]), "8_res");
		assert.equal(uniqueExtResourceId(["3", "9"]), "10");
		assert.equal(uniqueExtResourceId(["3", "9"], "3"), "10");
		assert.equal(uniqueExtResourceId(["2", "8_texture", "custom"]), "9_res");
		assert.equal(uniqueExtResourceId(["custom", "12abc", "res_99"]), "1_res");
		assert.equal(uniqueExtResourceId([], "2"), "1");
		assert.equal(uniqueExtResourceId(["9007199254740993_tex"]), "9007199254740994_res");
	});

	it("adds legacy numeric IDs and references and keeps load_steps in sync", () => {
		const legacy = SOURCE.replace("format=3", "format=2")
			.replace('id="1_script"', "id=4")
			.replace('ExtResource("1_script")', "ExtResource( 4 )");
		const result = applyResourceEdits(legacy, [
			{ kind: "addExtResource", type: "Texture", path: "res://icon.png" },
			{ kind: "addExtResource", type: "Texture", path: "res://other.png" },
		]);
		assert.deepEqual(result.createdIds, ["5", "6"]);
		assert.ok(result.text.includes('path="res://icon.png" id=5]'));
		assert.equal(parseResourceDocument(result.text).loadSteps, "5");
		assert.equal(resourceReference("Ext", "5", "2"), "ExtResource( 5 )");
		assert.equal(resourceReference("Ext", "5", "3"), 'ExtResource("5")');
		assert.equal(resourceReference("Ext", "6_res", "3"), 'ExtResource("6_res")');
		const removed = applyResourceEdits(result.text, [{ kind: "deleteExtResource", id: "6" }]);
		assert.equal(parseResourceDocument(removed.text).loadSteps, "4");
	});

	it("does not drop a sub-resource that shares a legacy external ID", () => {
		const text = `[gd_resource type="Resource" format=2]
[ext_resource type="Script" path="res://hero.gd" id=1]
[sub_resource type="Gradient" id=1]
[resource]
script = ExtResource( 1 )
gradient = SubResource( 1 )
`;
		const result = applyResourceEdits(text, [{ kind: "deleteExtResource", id: "1" }]);
		assert.ok(result.text.includes("script = null"));
		assert.ok(result.text.includes("gradient = SubResource( 1 )"));
	});

	it("rewrites references defensively", () => {
		assert.equal(rewriteReferences('a = SubResource("X")', "X", "Y"), 'a = SubResource("Y")');
		assert.equal(rewriteReferences('a = ExtResource("X")', "X", "Y"), 'a = ExtResource("Y")');
		assert.equal(rewriteReferences('a = SubResource("Other")', "X", "Y"), 'a = SubResource("Other")');
		assert.equal(rewriteReferences("a = SubResource( 63 )", "63", "70"), "a = SubResource( 70 )");
		assert.equal(rewriteReferences("a = SubResource( 63 )", "63", "Shader_1"), 'a = SubResource("Shader_1")');
	});

	it("deletes an external resource and drops its references", () => {
		const result = applyResourceEdits(SOURCE, [{ kind: "deleteExtResource", id: "1_script" }]);
		assert.ok(!result.text.includes("[ext_resource"));
		assert.ok(result.text.includes("script = null"));
	});
});

describe("resource document parse cache", () => {
	it("parses once per version and re-parses after a change", () => {
		const cache = createDocumentParseCache();
		let reads = 0;
		const read = () => {
			reads++;
			return SOURCE;
		};

		const first = cache.parse("file:///hero.tres", 1, read);
		const again = cache.parse("file:///hero.tres", 1, read);
		assert.equal(reads, 1);
		assert.equal(first, again);
		assert.equal(cache.size, 1);

		const edited = SOURCE.replace('script_class="Hero"', 'script_class="Villain"');
		const next = cache.parse("file:///hero.tres", 2, () => edited);
		assert.equal(reads, 1);
		assert.equal(next.scriptClass, "Villain");
		assert.equal(cache.parse("file:///hero.tres", 2, read), next);
	});

	it("keeps documents apart and forgets an invalidated one", () => {
		const cache = createDocumentParseCache();
		const other = `[gd_resource type="ShaderMaterial" format=3]\n\n[resource]\nshader = null\n`;
		cache.parse("file:///a.tres", 7, () => SOURCE);
		const shader = cache.parse("file:///b.tres", 7, () => other);
		assert.equal(shader.resourceType, "ShaderMaterial");
		assert.equal(cache.size, 2);

		cache.invalidate("file:///a.tres");
		assert.equal(cache.size, 1);
		let reads = 0;
		cache.parse("file:///a.tres", 7, () => {
			reads++;
			return SOURCE;
		});
		assert.equal(reads, 1);
	});

	it("stays bounded", () => {
		const cache = createDocumentParseCache(2);
		for (const name of ["a", "b", "c"]) cache.parse(`file:///${name}.tres`, 1, () => SOURCE);
		assert.equal(cache.size, 2);
	});
});
