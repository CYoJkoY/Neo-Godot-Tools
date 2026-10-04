import { strict as assert } from "node:assert";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { describe, it } from "node:test";
import type * as vscode from "vscode";
import { SceneParser } from "./parser.js";

const SCENE = `[gd_scene load_steps=3 format=3]

[ext_resource type="Script" path="res://player.gd" id="1_abc"]
[ext_resource type="Texture2D" path="res://icon.svg" id="2_def"]

[sub_resource type="RectangleShape2D" id="RectangleShape2D_1"]
size = Vector2(32, 32)

[node name="Player" type="CharacterBody2D"]
script = ExtResource("1_abc")
position = Vector2(10, 20)
metadata = {
"nested": true
}

[node name="Sprite" type="Sprite2D" parent="."]
texture = ExtResource("2_def")
position = Vector2(0, -8)

[connection signal="pressed" from="Sprite" to="." method="_on_pressed"]
`;

/** Minimal `TextDocument` for the parser: uri, text and line lookup. */
function fakeDocument(file: string, source: string): vscode.TextDocument {
	const lineStarts = [0];
	for (let index = 0; index < source.length; index++) if (source[index] === "\n") lineStarts.push(index + 1);
	return {
		uri: { fsPath: file, scheme: "file", toString: () => `file://${file}` },
		getText: () => source,
		positionAt: (offset: number) => {
			let low = 0;
			let high = lineStarts.length;
			while (low < high) {
				const middle = (low + high) >>> 1;
				if (lineStarts[middle] <= offset) low = middle + 1;
				else high = middle;
			}
			return { line: Math.max(0, low - 1), character: offset - lineStarts[Math.max(0, low - 1)] };
		},
		lineAt: (lineOrPosition: number | { line: number }) => {
			const line = typeof lineOrPosition === "number" ? lineOrPosition : lineOrPosition.line;
			return { lineNumber: line, text: source.split("\n")[line] ?? "" };
		},
	} as unknown as vscode.TextDocument;
}

function parse(source: string, name = "scene.tscn") {
	const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "ngdt-scene-")), name);
	fs.writeFileSync(file, source);
	const document = fakeDocument(file, source);
	const parser = new SceneParser();
	return {
		parser,
		scene: parser.parse_scene(document),
		file,
		dispose: () => fs.rmSync(path.dirname(file), { recursive: true, force: true }),
	};
}

describe("scene parser", () => {
	it("reads resources, nodes and node hierarchy in one pass", () => {
		const { scene, dispose } = parse(SCENE);
		try {
			assert.equal(scene.title, "scene.tscn");
			assert.equal([...scene.externalResources.keys()].join(","), "1_abc,2_def");
			assert.equal(scene.externalResources.get("1_abc")?.path, "res://player.gd");
			assert.equal(scene.subResources.get("RectangleShape2D_1")?.type, "RectangleShape2D");
			assert.equal(
				scene.subResources.get("RectangleShape2D_1")?.body,
				'[sub_resource type="RectangleShape2D" id="RectangleShape2D_1"]\nsize = Vector2(32, 32)',
				"a resource body carries its own header, up to the next section",
			);
			assert.deepEqual([...scene.nodes.keys()], ["Player", "Player/Sprite"]);
			assert.equal(scene.nodes.get("Player/Sprite")?.parent, "Player");
			assert.equal(scene.nodes.get("Player/Sprite")?.relativePath, "Sprite");
			assert.equal(scene.nodes.get("Player")?.children.length, 1);
			assert.equal(scene.root, scene.nodes.get("Player"));
		} finally {
			dispose();
		}
	});

	it("gives every node its overridden properties with file offsets", () => {
		const { scene, dispose } = parse(SCENE);
		try {
			const player = scene.nodes.get("Player")!;
			assert.deepEqual(
				player.properties.map((property) => property.name),
				["script", "position", "metadata"],
			);
			assert.equal(player.properties[1].raw, "Vector2(10, 20)");
			assert.equal(
				SCENE.slice(player.properties[1].start, player.properties[1].end),
				"position = Vector2(10, 20)",
			);
			// The multi-line dictionary value ends before the next section, not
			// somewhere inside the following node.
			assert.equal(player.properties[2].raw, '{\n"nested": true\n}');
			assert.equal(player.properties[2].reference, undefined);
			assert.equal(player.properties[0].reference, "ExtResource");

			const sprite = scene.nodes.get("Player/Sprite")!;
			assert.deepEqual(
				sprite.properties.map((property) => property.name),
				["texture", "position"],
			);
			// The node body stops at the connection section that follows it.
			assert.equal(SCENE.slice(sprite.bodyEnd, sprite.bodyEnd + 11), "[connection");
		} finally {
			dispose();
		}
	});

	it("reuses the parsed scene while the file is unchanged", () => {
		const { parser, scene, dispose } = parse(SCENE);
		try {
			const again = parser.parse_scene(fakeDocument(scene.path, SCENE));
			assert.equal(again, scene, "an unchanged file must not be parsed twice");
		} finally {
			dispose();
		}
	});

	it("ignores bracket text inside property values", () => {
		const source = `[node name="Root" type="Node"]
note = "[node name=\\"Fake\\" type=\\"Node\\"]"
real = 1
`;
		const { scene, dispose } = parse(source);
		try {
			assert.deepEqual([...scene.nodes.keys()], ["Root"]);
			assert.deepEqual(
				scene.nodes.get("Root")!.properties.map((property) => property.name),
				["note", "real"],
			);
		} finally {
			dispose();
		}
	});
});
