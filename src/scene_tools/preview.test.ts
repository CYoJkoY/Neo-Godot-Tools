import { strict as assert } from "node:assert";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, it, mock } from "node:test";
import * as vscode from "vscode";
import { ScenePreviewProvider } from "./preview.js";

function scriptScene(resourcePath: string): string {
	return `[gd_scene load_steps=2 format=2]

[ext_resource type="Script" path="${resourcePath}" id=1]

[node name="Player" type="Node2D"]
script = ExtResource( 1 )
`;
}

function storedValue<T>(key: string): T | undefined;
function storedValue<T>(key: string, fallback: T): T;
function storedValue<T>(_key: string, fallback?: T): T | undefined {
	return fallback;
}

describe("scene preview project resources", () => {
	let root: string;
	let workspaceFolder: string | undefined;
	let provider: ScenePreviewProvider;
	let subscriptions: vscode.Disposable[];
	let opened: string[];
	/**
	 * Commands registered by the provider under test. The stub records them too,
	 * but importing it here would pull `tools/` into the extension-host
	 * `rootDir`, so the test captures them through the public API instead.
	 */
	let handlers: Map<string, (...args: unknown[]) => unknown>;

	function writeFiles(files: Readonly<Record<string, string>>): void {
		for (const [relative, text] of Object.entries(files)) {
			const file = path.join(root, relative);
			fs.mkdirSync(path.dirname(file), { recursive: true });
			fs.writeFileSync(file, text);
		}
	}

	function parseScene(source: string): void {
		writeFiles({ "game/scenes/main.tscn": source });
		const document = {
			uri: vscode.Uri.file(path.join(root, "game/scenes/main.tscn")),
			getText: () => source,
		} as vscode.TextDocument;
		provider.scene = provider.parser.parse_scene(document);
	}

	async function checkScriptCommands(expected?: string): Promise<void> {
		const sceneRoot = provider.scene?.root;
		assert.ok(sceneRoot);
		const openScript = handlers.get("neoGodotTools.scenePreview.openScript");
		const openMainScript = handlers.get("neoGodotTools.scenePreview.openMainScript");
		assert.ok(openScript);
		assert.ok(openMainScript);
		await openScript(sceneRoot);
		await openMainScript();
		assert.deepEqual(opened, expected === undefined ? [] : [path.normalize(expected), path.normalize(expected)]);
	}

	beforeEach(() => {
		root = fs.mkdtempSync(path.join(os.tmpdir(), "ngdt-scene-project-"));
		workspaceFolder = root;
		opened = [];
		subscriptions = [];
		handlers = new Map();
		writeFiles({ "game/project.godot": "config_version=4\n" });
		mock.method(vscode.workspace, "getWorkspaceFolder", () =>
			workspaceFolder === undefined
				? undefined
				: { uri: vscode.Uri.file(workspaceFolder), name: "workspace", index: 0 },
		);
		mock.method(
			vscode.commands,
			"registerCommand",
			(id: string, handler: (...args: unknown[]) => unknown): vscode.Disposable => {
				handlers.set(id, handler);
				return { dispose: () => handlers.delete(id) };
			},
		);
		mock.method(vscode.window, "showTextDocument", async (uri: vscode.Uri) => {
			opened.push(path.normalize(uri.fsPath));
		});
		const context: Pick<vscode.ExtensionContext, "subscriptions" | "workspaceState"> = {
			subscriptions,
			workspaceState: { get: storedValue, keys: () => [], update: async () => {} },
		};
		provider = new ScenePreviewProvider(context as vscode.ExtensionContext);
	});

	afterEach(() => {
		for (const subscription of subscriptions) subscription.dispose();
		mock.restoreAll();
		fs.rmSync(root, { recursive: true, force: true });
	});

	it("opens scripts and resolves custom types inside a nested project despite workspace collisions", async () => {
		writeFiles({
			"player.gd": "extends Node2D\nclass_name OutsidePlayer\n",
			"game/player.gd": "extends Node2D\nclass_name Player\n",
		});
		parseScene(scriptScene("res://player.gd"));
		assert.equal(provider.scene?.root?.className, "Player");
		await checkScriptCommands(path.join(root, "game/player.gd"));
	});

	it("chooses the nearest project when both parent and child have project.godot", async () => {
		writeFiles({
			"project.godot": "config_version=4\n",
			"player.gd": "extends Node2D\nclass_name OuterPlayer\n",
			"game/player.gd": "extends Node2D\nclass_name InnerPlayer\n",
		});
		parseScene(scriptScene("res://player.gd"));
		assert.equal(provider.scene?.root?.className, "InnerPlayer");
		await checkScriptCommands(path.join(root, "game/player.gd"));
	});

	it("does not fall back to a colliding workspace script when the project resource is missing", async () => {
		writeFiles({ "player.gd": "extends Node2D\nclass_name OutsidePlayer\n" });
		parseScene(scriptScene("res://player.gd"));
		assert.equal(provider.scene?.root?.className, "Node2D");
		await checkScriptCommands();
	});

	it("keeps project-root workspaces working", async () => {
		workspaceFolder = path.join(root, "game");
		writeFiles({ "game/player.gd": "extends Node2D\nclass_name ProjectPlayer\n" });
		parseScene(scriptScene("res://player.gd"));
		assert.equal(provider.scene?.root?.className, "ProjectPlayer");
		await checkScriptCommands(path.join(root, "game/player.gd"));
	});

	it("finds the owning project without a workspace folder", async () => {
		workspaceFolder = undefined;
		writeFiles({ "game/player.gd": "extends Node2D\nclass_name StandalonePlayer\n" });
		parseScene(scriptScene("res://player.gd"));
		assert.equal(provider.scene?.root?.className, "StandalonePlayer");
		await checkScriptCommands(path.join(root, "game/player.gd"));
	});

	it("preserves file-relative script paths", async () => {
		writeFiles({ "game/player.gd": "extends Node2D\nclass_name RelativePlayer\n" });
		parseScene(scriptScene("../player.gd"));
		assert.equal(provider.scene?.root?.className, "RelativePlayer");
		await checkScriptCommands(path.join(root, "game/player.gd"));
	});

	it("resolves res:// paths that point into a project subdirectory", async () => {
		writeFiles({
			"player.gd": "extends Node2D\nclass_name OutsideNestedPlayer\n",
			"game/scripts/actors/player.gd": "extends Node2D\nclass_name NestedPlayer\n",
		});
		parseScene(scriptScene("res://scripts/actors/player.gd"));
		assert.equal(provider.scene?.root?.className, "NestedPlayer");
		await checkScriptCommands(path.join(root, "game/scripts/actors/player.gd"));
	});

	it("preserves absolute script paths", async () => {
		writeFiles({ "player.gd": "extends Node2D\nclass_name AbsolutePlayer\n" });
		const script = path.join(root, "player.gd");
		parseScene(scriptScene(script.replace(/\\/g, "/")));
		assert.equal(provider.scene?.root?.className, "AbsolutePlayer");
		await checkScriptCommands(script);
	});

	it("keeps user:// resources unsupported", async () => {
		writeFiles({ "game/player.gd": "extends Node2D\nclass_name UserPlayer\n" });
		parseScene(scriptScene("user://player.gd"));
		assert.equal(provider.scene?.root?.className, "Node2D");
		await checkScriptCommands();
	});

	it("preserves workspace resolution for loose scenes without a project", async () => {
		fs.unlinkSync(path.join(root, "game/project.godot"));
		writeFiles({ "player.gd": "extends Node2D\nclass_name WorkspacePlayer\n" });
		parseScene(scriptScene("res://player.gd"));
		assert.equal(provider.scene?.root?.className, "WorkspacePlayer");
		await checkScriptCommands(path.join(root, "player.gd"));
	});

	it("leaves res:// unresolved without a project or workspace", async () => {
		fs.unlinkSync(path.join(root, "game/project.godot"));
		workspaceFolder = undefined;
		parseScene(scriptScene("res://player.gd"));
		assert.equal(provider.scene?.root?.className, "Node2D");
		await checkScriptCommands();
	});

	it("resolves script inheritance from the same nested project", async () => {
		writeFiles({
			"base.gd": "extends Node2D\nclass_name WrongBase\n",
			"game/player.gd": 'extends "res://base.gd"\n',
			"game/base.gd": "extends Node2D\nclass_name ProjectBase\n",
		});
		parseScene(scriptScene("res://player.gd"));
		assert.equal(provider.scene?.root?.className, "ProjectBase");
		await checkScriptCommands(path.join(root, "game/player.gd"));
	});

	it("parses and opens instanced scenes in the nested project", async () => {
		writeFiles({
			"child.tscn": '[node name="WrongChild" type="Node2D"]\n',
			"game/child.tscn": scriptScene("res://player.gd"),
			"game/player.gd": "extends Node2D\nclass_name InstancedPlayer\n",
		});
		parseScene(`[gd_scene load_steps=2 format=2]

[ext_resource type="PackedScene" path="res://child.tscn" id=1]

[node name="Instance" instance=ExtResource( 1 )]
`);
		const sceneRoot = provider.scene?.root;
		assert.ok(sceneRoot);
		assert.equal(sceneRoot.instanceScene?.path, path.join(root, "game/child.tscn"));
		assert.equal(sceneRoot.className, "InstancedPlayer");
		await checkScriptCommands(path.join(root, "game/player.gd"));
		opened.length = 0;
		const openScene = handlers.get("neoGodotTools.scenePreview.openScene");
		assert.ok(openScene);
		await openScene(sceneRoot);
		assert.deepEqual(opened, [path.join(root, "game/child.tscn")]);
	});
});
