import { strict as assert } from "node:assert";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { describe, it } from "node:test";
import * as vscode from "vscode";
import { SceneParser } from "../scene_tools/parser.js";
import { buildScenePreviewModel, buildShaderPreviewModel } from "./static_preview.js";

function makeDocument(uri: vscode.Uri, source: string): vscode.TextDocument {
	return {
		uri,
		languageId: uri.path.endsWith(".tscn") ? "gdscene" : "gdshader",
		version: 1,
		isDirty: false,
		lineCount: source.split(/\r?\n/).length,
		getText: () => source,
		lineAt: (line: number) => ({
			text: source.split(/\r?\n/)[line] ?? "",
			lineNumber: line,
			range: new vscode.Range(line, 0, line, (source.split(/\r?\n/)[line] ?? "").length),
		}),
		offsetAt: () => 0,
		positionAt: () => new vscode.Position(0, 0),
		getWordRangeAtPosition: () => undefined,
	} as unknown as vscode.TextDocument;
}

describe("static previews", () => {
	it("builds a positioned 2D model with nested controls and a scoped texture URI", () => {
		const root = fs.mkdtempSync(path.join(os.tmpdir(), "ngdt-scene-preview-"));
		try {
			fs.writeFileSync(path.join(root, "project.godot"), "[application]\n");
			fs.mkdirSync(path.join(root, "assets"));
			fs.writeFileSync(path.join(root, "assets", "icon.svg"), '<svg xmlns="http://www.w3.org/2000/svg"/>');
			const scenePath = path.join(root, "main.tscn");
			const source = `[gd_scene load_steps=2 format=3]\n\n[ext_resource type="Texture2D" path="res://assets/icon.svg" id="1_icon"]\n\n[node name="Root" type="Node2D"]\nposition = Vector2(10, 20)\n\n[node name="Sprite" type="Sprite2D" parent="."]\nposition = Vector2(5, 6)\ntexture = ExtResource("1_icon")\n\n[node name="Panel" type="ColorRect" parent="."]\nposition = Vector2(-4, 8)\nsize = Vector2(100, 40)\ncolor = Color(1, 0, 0, 0.5)\n\n[node name="Title" type="Label" parent="Panel"]\nposition = Vector2(2, 3)\ntext = "Hello"\n`;
			fs.writeFileSync(scenePath, source);
			const document = makeDocument(vscode.Uri.file(scenePath), source);
			const scene = new SceneParser().parse_scene(document);
			const webview = {
				asWebviewUri: (uri: vscode.Uri) => vscode.Uri.parse(`https://images.example/${uri.path}`),
			} as unknown as vscode.Webview;
			const model = buildScenePreviewModel(scene, webview);

			assert.equal(model.nodes.length, 1);
			const rootNode = model.nodes[0];
			assert.equal(rootNode.className, "Node2D");
			assert.deepEqual([rootNode.x, rootNode.y], [10, 20]);
			const sprite = rootNode.children.find((node) => node.label === "Sprite");
			assert.ok(sprite);
			assert.equal(sprite.texturePath, "res://assets/icon.svg");
			assert.match(sprite.textureUri ?? "", /^https:\/\/images\.example\//);
			const panel = rootNode.children.find((node) => node.label === "Panel");
			assert.ok(panel);
			assert.deepEqual([panel.x, panel.y, panel.width, panel.height], [-4, 8, 100, 40]);
			assert.equal(panel.children[0]?.text, "Hello");
			assert.equal(panel.children[0]?.position > panel.position, true);
			assert.deepEqual(model.warnings, []);
		} finally {
			fs.rmSync(root, { recursive: true, force: true });
		}
	});

	it("extracts canvas shader uniforms and warns for unsupported preview types", () => {
		const uri = vscode.Uri.file(path.join(os.tmpdir(), "preview.gdshader"));
		const model = buildShaderPreviewModel(
			`shader_type canvas_item;\nuniform float strength : hint_range(0., 1.) = 0.5;\nuniform vec4 tint : source_color = vec4(1.0, 0.0, 0.0, 1.0);\n`,
			uri,
		);
		assert.equal(model.shaderType, "canvas_item");
		assert.deepEqual(
			model.uniforms.map((uniform) => [uniform.name, uniform.type, uniform.defaultValue]),
			[
				["strength", "float", "0.5"],
				["tint", "Color", "Color(1, 0, 0, 1)"],
			],
		);
		assert.equal(model.warnings.length, 1);

		const spatial = buildShaderPreviewModel("shader_type spatial;\nuniform sampler2D albedo;\n", uri);
		assert.equal(spatial.shaderType, "spatial");
		assert.equal(spatial.uniforms[0]?.type, "Texture2D");
		assert.match(spatial.warnings[0] ?? "", /canvas_item/);
		assert.match(spatial.warnings[1] ?? "", /does not execute/);
	});

	it("summarizes shader interfaces and reports structural diagnostics", () => {
		const uri = vscode.Uri.file(path.join(os.tmpdir(), "preview.shader"));
		const model = buildShaderPreviewModel(
			"shader_type spatial;\nrender_mode unshaded, cull_disabled;\nuniform float gain : hint_range(0, 2) = 1.0;\nvoid fragment() {\n",
			uri,
		);
		assert.deepEqual(model.renderModes, ["unshaded", "cull_disabled"]);
		assert.deepEqual(model.functions, ["fragment"]);
		assert.equal(model.uniforms[0]?.hint, "range");
		assert.equal(model.diagnostics[0]?.message, "Unclosed shader block.");
		assert.equal(model.diagnostics[0]?.line, 4);
	});

	it("ignores commented shader syntax and reports the original line", () => {
		const uri = vscode.Uri.file(path.join(os.tmpdir(), "commented.shader"));
		const model = buildShaderPreviewModel(
			"shader_type canvas_item; // render_mode bogus;\n/* void fake() { */\nvoid fragment() {\n  COLOR = vec4(1.0);\n}\n",
			uri,
		);
		assert.deepEqual(model.functions, ["fragment"]);
		assert.deepEqual(model.renderModes, []);
		assert.deepEqual(model.diagnostics, []);
	});

	it("preserves local transforms for rotated and scaled nodes", () => {
		const root = fs.mkdtempSync(path.join(os.tmpdir(), "ngdt-scene-transform-"));
		try {
			fs.writeFileSync(path.join(root, "project.godot"), "[application]\\n");
			const scenePath = path.join(root, "transform.tscn");
			const source = `[gd_scene load_steps=1 format=3]\n\n[node name="Root" type="Node2D"]\n\n[node name="Rotated" type="ColorRect" parent="."]\nposition = Vector2(10, 20)\nrotation = 1.5707963\nscale = Vector2(2, 0.5)\nsize = Vector2(30, 40)\n`;
			fs.writeFileSync(scenePath, source);
			const scene = new SceneParser().parse_scene(makeDocument(vscode.Uri.file(scenePath), source));
			const model = buildScenePreviewModel(scene);
			const node = model.nodes[0]?.children[0];
			assert.ok(node);
			assert.deepEqual([node.x, node.y], [10, 20]);
			assert.deepEqual([node.scaleX, node.scaleY], [2, 0.5]);
			assert.ok(Math.abs(node.rotation - 90) < 0.001);
		} finally {
			fs.rmSync(root, { recursive: true, force: true });
		}
	});
});
