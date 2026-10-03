import { strict as assert } from "node:assert";
import { describe, it } from "node:test";
import { type NodeSection, parseNodeProperties, planPropertyWrite } from "./properties.js";

const SCENE = `[gd_scene load_steps=2 format=3]

[ext_resource type="Script" path="res://player.gd" id="1_abc"]

[node name="Player" type="CharacterBody2D"]
script = ExtResource("1_abc")
position = Vector2(10, 20)
collision_layer = 3

[node name="Sprite" type="Sprite2D" parent="."]
position = Vector2(0, -8)
metadata/_edit_lock_ = true
`;

function sectionOf(text: string, nodePath: string): NodeSection {
	const header = text.indexOf(`[node name="${nodePath}"`);
	assert.ok(header >= 0, `node ${nodePath} not found`);
	const next = text.indexOf("\n[node", header + 1);
	const bodyEnd = next < 0 ? text.length : next + 1;
	return {
		headerStart: header,
		headerEnd: text.indexOf("\n", header),
		bodyEnd,
		properties: parseNodeProperties(text, header, bodyEnd),
	};
}

function applyEdit(text: string, start: number, end: number, newText: string): string {
	return text.slice(0, start) + newText + text.slice(end);
}

describe("scene node properties", () => {
	it("parses the overridden properties of a node with their offsets", () => {
		const section = sectionOf(SCENE, "Player");
		assert.deepEqual(
			section.properties.map((property) => property.name),
			["script", "position", "collision_layer"],
		);
		const position = section.properties[1];
		assert.equal(position.raw, "Vector2(10, 20)");
		assert.equal(SCENE.slice(position.start, position.end), "position = Vector2(10, 20)");
		assert.equal(section.properties[0].reference, "ExtResource");
		assert.equal(section.properties[1].reference, undefined);
	});

	it("keeps multi-line values inside one property", () => {
		const text = `[node name="Root" type="Node"]
custom = {
"a": 1,
"b": 2
}
other = 1
`;
		const properties = parseNodeProperties(text, 0, text.length);
		assert.deepEqual(
			properties.map((property) => property.name),
			["custom", "other"],
		);
		assert.equal(properties[0].raw, '{\n"a": 1,\n"b": 2\n}');
		assert.equal(properties[1].raw, "1");
	});

	it("stops a value before the next section", () => {
		const text = `[node name="Root" type="Node"]
pressed = false

[connection signal="pressed" from="." to="." method="on_pressed"]
`;
		const properties = parseNodeProperties(text, 0, text.length);
		assert.deepEqual(properties.map((property) => property.name), ["pressed"]);
		assert.equal(properties[0].raw, "false");
	});

	it("does not read the node header as a property", () => {
		const text = `[node name="Root" type="Node"]
[node name="Child" type="Node" parent="."]
`;
		assert.deepEqual(parseNodeProperties(text, 0, text.length), []);
	});

	it("replaces only the value of an existing property", () => {
		const section = sectionOf(SCENE, "Player");
		const plan = planPropertyWrite(SCENE, section, "position", "Vector2(30, 40)");
		assert.ok(plan);
		const updated = applyEdit(SCENE, plan.start, plan.end, plan.newText);
		assert.ok(updated.includes("position = Vector2(30, 40)"));
		assert.ok(updated.includes('script = ExtResource("1_abc")'), "other properties must survive");
	});

	it("appends a new property to the end of the node section", () => {
		const section = sectionOf(SCENE, "Player");
		const plan = planPropertyWrite(SCENE, section, "motion_mode", "1");
		assert.ok(plan);
		const updated = applyEdit(SCENE, plan.start, plan.end, plan.newText);
		const player = updated.slice(updated.indexOf('[node name="Player"'), updated.indexOf('[node name="Sprite"'));
		assert.ok(player.includes("collision_layer = 3\nmotion_mode = 1"), `unexpected section:\n${player}`);
		assert.ok(
			updated.includes('[node name="Sprite" type="Sprite2D" parent="."]'),
			"the next node must stay intact",
		);
	});

	it("adds the first property of a node that has none", () => {
		const text = `[node name="Root" type="Node"]

[node name="Child" type="Node" parent="."]
`;
		const section = sectionOf(text, "Child");
		assert.deepEqual(section.properties, []);
		const plan = planPropertyWrite(text, section, "visible", "false");
		assert.ok(plan);
		const updated = applyEdit(text, plan.start, plan.end, plan.newText);
		assert.equal(
			updated,
			'[node name="Root" type="Node"]\n\n[node name="Child" type="Node" parent="."]\nvisible = false\n',
		);
	});

	it("removes a property together with its line", () => {
		const section = sectionOf(SCENE, "Sprite");
		const plan = planPropertyWrite(SCENE, section, "metadata/_edit_lock_", null);
		assert.ok(plan);
		const updated = applyEdit(SCENE, plan.start, plan.end, plan.newText);
		assert.equal(updated.includes("_edit_lock_"), false);
		assert.ok(updated.includes("position = Vector2(0, -8)"), "the remaining property must stay");
		assert.ok(
			updated.endsWith('[node name="Sprite" type="Sprite2D" parent="."]\nposition = Vector2(0, -8)\n'),
			JSON.stringify(updated),
		);
	});

	it("reports no edit when removing a property that is not overridden", () => {
		const section = sectionOf(SCENE, "Sprite");
		assert.equal(planPropertyWrite(SCENE, section, "z_index", null), undefined);
	});

	it("round-trips every property through an edit", () => {
		const section = sectionOf(SCENE, "Player");
		let updated = SCENE;
		for (const property of section.properties) {
			const plan = planPropertyWrite(updated, sectionOf(updated, "Player"), property.name, property.raw);
			assert.ok(plan);
			updated = applyEdit(updated, plan.start, plan.end, plan.newText);
		}
		assert.equal(updated, SCENE, "rewriting the same values must not change the file");
	});
});
