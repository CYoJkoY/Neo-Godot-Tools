import { strict as assert } from "node:assert";
import { after, describe, it } from "node:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import * as vscode from "vscode";
import { apply_custom_class_icons } from "./node_icons.js";
import { SceneParser } from "./parser.js";
import type { Scene } from "./types.js";

const projectDir = fs.mkdtempSync(path.join(os.tmpdir(), "neo-godot-icons-"));

fs.writeFileSync(path.join(projectDir, "project.godot"), "");
fs.writeFileSync(path.join(projectDir, "hitbox.gd"), "class_name Hitbox\nextends Area2D\n");
fs.writeFileSync(path.join(projectDir, "hitbox_chain.gd"), "class_name HitboxChain\nextends Hitbox\n");

after(() => {
	fs.rmSync(projectDir, { recursive: true, force: true });
});

function parseScene(name: string, text: string): Scene {
	const file = path.join(projectDir, name);
	fs.writeFileSync(file, text);
	const document = {
		uri: vscode.Uri.file(file),
		languageId: "gdscene",
		getText: () => text,
		lineAt: () => ({ lineNumber: 0 }),
		positionAt: () => new vscode.Position(0, 0),
	} as unknown as vscode.TextDocument;
	return new SceneParser().parse_scene(document);
}

async function iconClassOf(name: string, text: string, label = "Hitbox"): Promise<string> {
	const scene = parseScene(name, text);
	await apply_custom_class_icons(scene);
	const node = [...scene.nodes.values()].find((candidate) => candidate.label === label);
	assert.ok(node, `node ${label} was parsed`);
	return node.iconClass;
}

describe("scene preview node icons", () => {
	it("keeps the engine type icon when the scene stores the engine type", async () => {
		const icon = await iconClassOf("engine_type.tscn", `[gd_scene load_steps=2 format=3]

[ext_resource type="Script" path="res://hitbox.gd" id="1_hb"]

[node name="Hitbox" type="Area2D"]
script = ExtResource("1_hb")
`);
		assert.equal(icon, "Area2D");
	});

	it("maps a custom class type back to its base engine icon", async () => {
		const icon = await iconClassOf("custom_type.tscn", `[gd_scene format=3]

[node name="Hitbox" type="Hitbox"]
`);
		assert.equal(icon, "Area2D");
	});

	it("follows the script inheritance chain of custom classes", async () => {
		const icon = await iconClassOf("custom_chain.tscn", `[gd_scene format=3]

[node name="Hitbox" type="HitboxChain"]
`);
		assert.equal(icon, "Area2D");
	});

	it("falls back to the default icon for unknown types", async () => {
		const icon = await iconClassOf("unknown.tscn", `[gd_scene format=3]

[node name="Hitbox" type="TotallyUnknownThing"]
`);
		assert.equal(icon, "Node");
	});

	it("resolves the icon of a custom class with a script resource", async () => {
		const icon = await iconClassOf("scripted.tscn", `[gd_scene load_steps=2 format=3]

[ext_resource type="Script" path="res://hitbox_chain.gd" id="1_hb"]

[node name="Hitbox" type="HitboxChain"]
script = ExtResource("1_hb")
`);
		assert.equal(icon, "Area2D");
	});
});
