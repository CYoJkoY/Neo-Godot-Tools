import { strict as assert } from "node:assert";
import { describe, it } from "node:test";
import {
	addSceneExternalResource,
	addSceneSubResource,
	replaceSceneArrayItem,
	sceneExternalResourceId,
	sceneExternalResourceType,
	sceneFormat,
	sceneResourceHeaders,
	sceneResourceReference,
	uniqueSceneSubResourceId,
} from "./resources.js";

const SCENE = `[gd_scene load_steps=1 format=3]\n\n[node name="Root" type="Node"]\n`;

describe("scene resource editing helpers", () => {
	it("adds external resources with unique IDs, format-compatible references, and load steps", () => {
		const first = addSceneExternalResource(SCENE, { type: "Texture2D", path: "res://art/icon.svg" });
		assert.equal(first.id, "1_res");
		assert.equal(first.changed, true);
		assert.equal(sceneFormat(first.text), "3");
		assert.match(first.text, /\[ext_resource type="Texture2D" path="res:\/\/art\/icon\.svg" id="1_res"\]/);
		assert.match(first.text, /^\[gd_scene load_steps=2 format=3\]/);
		assert.equal(sceneExternalResourceId(first.text, "res://art/icon.svg"), first.id);

		const duplicate = addSceneExternalResource(first.text, { type: "Texture2D", path: "res://art/icon.svg" });
		assert.equal(duplicate.changed, false);
		assert.equal(duplicate.id, first.id);
		assert.equal(duplicate.text, first.text);
		const collision = addSceneExternalResource(first.text, {
			type: "Script",
			path: "res://other.gd",
			id: first.id,
		});
		assert.equal(collision.id, "");
		assert.equal(collision.changed, false);

		const second = addSceneExternalResource(first.text, { type: "Script", path: "res://player.gd" });
		assert.equal(second.id, "2_res");
		assert.match(second.text, /^\[gd_scene load_steps=3 format=3\]/);
		assert.equal(
			sceneResourceHeaders(second.text).filter((resource) => resource.kind === "ext_resource").length,
			2,
		);
		assert.equal(sceneResourceReference("Ext", second.id, second.text), 'ExtResource("2_res")');
	});

	it("keeps Godot 3 numeric resource IDs and unquoted references", () => {
		const godot3 = `[gd_scene load_steps=2 format=2]\n\n[ext_resource type="Script" path="res://main.gd" id=7]\n\n[node name="Root" type="Node"]\n`;
		const added = addSceneExternalResource(godot3, { type: "Texture", path: "res://icon.png" });
		assert.equal(added.id, "8");
		assert.match(added.text, /\[ext_resource type="Texture" path="res:\/\/icon\.png" id=8\]/);
		assert.equal(sceneResourceReference("Ext", added.id, added.text), "ExtResource( 8 )");
		assert.equal(uniqueSceneSubResourceId(added.text, "StyleBox"), "1");
		const sub = addSceneSubResource(added.text, { type: "StyleBox" });
		assert.match(sub.text, /\[sub_resource type="StyleBox" id=1\]/);
		assert.match(sub.text, /^\[gd_scene load_steps=4 format=2\]/);
	});

	it("inserts embedded resources before nodes and parses their properties", () => {
		const added = addSceneSubResource(SCENE, {
			type: "GradientTexture2D",
			properties: { width: "128", gradient: 'SubResource("Gradient_1")' },
		});
		assert.equal(added.id, "GradientTexture2D_1");
		assert.ok(added.text.indexOf("[sub_resource") < added.text.indexOf("[node"));
		assert.match(added.text, /width = 128/);
		assert.match(added.text, /^\[gd_scene load_steps=2 format=3\]/);
		assert.equal(uniqueSceneSubResourceId(added.text, "GradientTexture2D"), "GradientTexture2D_2");
		assert.equal(sceneResourceHeaders(added.text).at(-1)?.id, added.id);
		const collision = addSceneSubResource(added.text, { type: "StyleBoxFlat", id: added.id });
		assert.equal(collision.id, "");
		assert.equal(collision.changed, false);
		assert.equal(sceneResourceReference("Sub", added.id, added.text), 'SubResource("GradientTexture2D_1")');
	});

	it("replaces one array member while retaining typed and packed syntax", () => {
		assert.equal(
			replaceSceneArrayItem('Array[Resource]([SubResource("A_1"), null])', 1, 'ExtResource("2_res")'),
			'Array[Resource]([SubResource("A_1"), ExtResource("2_res")])',
		);
		assert.equal(replaceSceneArrayItem("PackedInt32Array(1, 2, 3)", 1, "9"), "PackedInt32Array(1, 9, 3)");
		assert.equal(replaceSceneArrayItem("[1, 2]", 2, "3"), undefined);
		assert.equal(replaceSceneArrayItem("not an array", 0, "3"), undefined);
	});

	it("infers resource classes from common Godot file extensions", () => {
		assert.equal(sceneExternalResourceType("player.gd", "3"), "Script");
		assert.equal(sceneExternalResourceType("world.tscn", "3"), "PackedScene");
		assert.equal(sceneExternalResourceType("icon.png", "2"), "Texture");
		assert.equal(sceneExternalResourceType("icon.png", "3"), "Texture2D");
		assert.equal(
			sceneExternalResourceType("material.tres", "3", '[gd_resource type="ShaderMaterial" format=3]'),
			"ShaderMaterial",
		);
		assert.equal(sceneExternalResourceType("unknown.bin", "3", undefined, "AudioStream"), "AudioStream");
	});
});
