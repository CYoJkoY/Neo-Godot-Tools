import { strict as assert } from "node:assert";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, describe, it, mock } from "node:test";
import * as vscode from "vscode";
import { SceneNode } from "./types.js";
import { NodePropertyMetadata } from "./property_editor.js";
import { Scene } from "./types.js";

const scene = new Scene({
	path: "/tmp/scene.tscn",
	title: "scene.tscn",
	mtime: 0,
	source: "",
	fingerprint: "",
});

describe("scene property metadata fallback", () => {
	it("uses the Resource Inspector's built-in schemas for embedded resources", async () => {
		const properties = await new NodePropertyMetadata().forClass("StandardMaterial3D");
		assert.equal(properties.find((property) => property.name === "albedo_color")?.type, "Color");
		assert.equal(properties.find((property) => property.name === "roughness")?.defaultValue, "1.0");
	});

	it("infers embedded resource classes and typed Resource arrays from scene values", async () => {
		const node = new SceneNode({
			label: "Root",
			className: "Node",
			path: "Root",
			relativePath: "",
			parent: "",
			text: '[node name="Root" type="Node"]',
			position: 0,
			bodyEnd: 200,
		});
		node.properties = [
			{
				name: "material",
				raw: 'SubResource("Material_1")',
				start: 0,
				end: 0,
				valueStart: 0,
				valueEnd: 0,
			},
			{
				name: "materials",
				raw: 'Array[Resource]([SubResource("Material_1")])',
				start: 0,
				end: 0,
				valueStart: 0,
				valueEnd: 0,
			},
		];
		scene.subResources.set("Material_1", {
			path: "",
			type: "StandardMaterial3D",
			uid: "",
			id: "Material_1",
			index: 0,
			line: 1,
			bodyEnd: 0,
			body: "",
			properties: [],
		});

		const metadata = await new NodePropertyMetadata().forNode(scene, node);
		assert.equal(metadata.find((property) => property.name === "material")?.type, "StandardMaterial3D");
		assert.equal(metadata.find((property) => property.name === "materials")?.type, "Array[Resource]");
	});

	it("does not cache the missing LSP client before it connects", async () => {
		let connected = false;
		const metadata = new NodePropertyMetadata({
			lspClient: () =>
				connected
					? {
							sendRequest: async () => ({
								children: [{ name: "custom_value", detail: 'var custom_value: String = "ready"' }],
							}),
						}
					: undefined,
		});
		assert.equal(
			(await metadata.forClass("CustomSceneResource")).some((property) => property.name === "custom_value"),
			false,
		);
		connected = true;
		assert.equal(
			(await metadata.forClass("CustomSceneResource")).find((property) => property.name === "custom_value")
				?.defaultValue,
			'"ready"',
		);
	});

	it("infers a Resource array type from homogeneous untyped references", async () => {
		const node = new SceneNode({
			label: "Root",
			className: "Node",
			path: "Root",
			relativePath: "",
			parent: "",
			text: '[node name="Root" type="Node"]',
			position: 0,
			bodyEnd: 100,
		});
		node.properties = [
			{
				name: "materials",
				raw: '[SubResource("Material_1"), SubResource("Material_2")]',
				start: 0,
				end: 0,
				valueStart: 0,
				valueEnd: 0,
			},
		];
		scene.subResources.set("Material_1", {
			path: "",
			type: "StandardMaterial3D",
			uid: "",
			id: "Material_1",
			index: 0,
			line: 1,
			bodyEnd: 0,
			body: "",
			properties: [],
		});
		scene.subResources.set("Material_2", {
			path: "",
			type: "StandardMaterial3D",
			uid: "",
			id: "Material_2",
			index: 0,
			line: 1,
			bodyEnd: 0,
			body: "",
			properties: [],
		});

		const metadata = await new NodePropertyMetadata().forNode(scene, node);
		assert.equal(metadata.find((property) => property.name === "materials")?.type, "Array[StandardMaterial3D]");
	});

	describe("script metadata for a nested project", () => {
		let root: string | undefined;

		afterEach(() => {
			mock.restoreAll();
			if (root !== undefined) fs.rmSync(root, { recursive: true, force: true });
			root = undefined;
		});

		it("reads @export properties from the scene's own project instead of a workspace collision", async () => {
			const temp = fs.mkdtempSync(path.join(os.tmpdir(), "ngdt-property-script-"));
			root = temp;
			const project = path.join(temp, "game");
			fs.mkdirSync(path.join(project, "scenes"), { recursive: true });
			fs.writeFileSync(path.join(project, "project.godot"), "config_version=4\n");
			fs.writeFileSync(path.join(temp, "player.gd"), "extends Node2D\n@export var outside_value: int\n");
			fs.writeFileSync(path.join(project, "player.gd"), "extends Node2D\n@export var project_value: float\n");
			mock.method(vscode.workspace, "getWorkspaceFolder", () => ({
				uri: vscode.Uri.file(temp),
				name: "workspace",
				index: 0,
			}));

			const nested = new Scene({
				path: path.join(project, "scenes", "main.tscn"),
				title: "main.tscn",
				mtime: 0,
				source: "",
				fingerprint: "",
			});
			nested.externalResources.set("1", {
				path: "res://player.gd",
				type: "Script",
				id: "1",
				uid: "",
				body: "",
				index: 0,
				line: 1,
			});
			const node = new SceneNode({
				label: "Player",
				className: "Node2D",
				path: "Player",
				relativePath: "",
				parent: "",
				text: '[node name="Player" type="Node2D"]',
				position: 0,
				bodyEnd: 100,
			});
			node.scriptId = "1";

			const metadata = await new NodePropertyMetadata().forNode(nested, node);
			assert.ok(metadata.some((property) => property.name === "project_value"));
			assert.equal(metadata.some((property) => property.name === "outside_value"), false);
		});
	});
});
