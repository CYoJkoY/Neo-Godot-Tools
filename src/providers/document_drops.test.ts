import { strict as assert } from "node:assert";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, it, mock } from "node:test";
import * as vscode from "vscode";
import { createDocumentDropEditProvider, type GDDocumentDropEditProvider } from "./document_drops.js";

const SCENE = `[gd_scene load_steps=2 format=3]

[ext_resource type="Script" path="res://player.gd" id="1"]

[node name="Player" type="Node2D"]
script = ExtResource("1")

[node name="Sprite" type="Sprite2D" parent="."]
`;

function textDocument(file: string, text: string): vscode.TextDocument {
	return {
		uri: vscode.Uri.file(file),
		languageId: "gdscript",
		getText: () => text,
		lineAt: () => ({ text: "" }),
	} as unknown as vscode.TextDocument;
}

function dropData(entries: Readonly<Record<string, unknown>>): vscode.DataTransfer {
	const data = new vscode.DataTransfer();
	for (const [key, value] of Object.entries(entries)) data.set(key, new vscode.DataTransferItem(value));
	return data;
}

describe("scene node drops", () => {
	let root: string;
	let provider: GDDocumentDropEditProvider;
	let subscriptions: vscode.Disposable[];

	beforeEach(() => {
		root = fs.mkdtempSync(path.join(os.tmpdir(), "ngdt-drop-"));
		fs.mkdirSync(path.join(root, "game"), { recursive: true });
		// Both an outer project and the nested one, so the workspace-global
		// lookup would express the dropped script as `res://game/player.gd`.
		fs.writeFileSync(path.join(root, "project.godot"), "config_version=4\n");
		fs.writeFileSync(path.join(root, "player.gd"), "extends Node2D\nclass_name OuterPlayer\n");
		fs.writeFileSync(path.join(root, "game", "project.godot"), "config_version=4\n");
		fs.writeFileSync(path.join(root, "game", "main.tscn"), SCENE);
		fs.writeFileSync(path.join(root, "game", "player.gd"), "extends Node2D\nclass_name Player\n");
		subscriptions = [];
		// The workspace is an ancestor of the project, as in issue #263.
		mock.method(vscode.workspace, "getWorkspaceFolder", () => ({
			uri: vscode.Uri.file(root),
			name: "workspace",
			index: 0,
		}));
		mock.method(vscode.workspace, "openTextDocument", async (uri: vscode.Uri) => textDocument(uri.fsPath, SCENE));
		provider = createDocumentDropEditProvider({
			subscriptions,
		} as unknown as vscode.ExtensionContext);
	});

	afterEach(() => {
		for (const subscription of subscriptions) subscription.dispose();
		mock.restoreAll();
		fs.rmSync(root, { recursive: true, force: true });
	});

	it("keeps node paths relative to the script owner inside a nested project", async () => {
		const document = textDocument(path.join(root, "game", "player.gd"), "");
		const edit = await provider.provideDocumentDropEdits(
			document,
			new vscode.Position(0, 0),
			dropData({
				"godot/scene": path.join(root, "game", "main.tscn"),
				"godot/class": "Sprite2D",
				"godot/path": "Player/Sprite",
				"godot/relativePath": "Player/Sprite",
				"godot/label": "Sprite",
				"godot/unique": false,
			}),
			{ isCancellationRequested: false } as vscode.CancellationToken,
		);
		assert.ok(edit);
		assert.ok(!Array.isArray(edit), "the provider returns a single edit");
		const insertText = edit.insertText;
		assert.ok(insertText instanceof vscode.SnippetString);
		// The dropped node is the script's child, so the path is `Sprite`, not the
		// node's root-relative path from the scene.
		assert.ok(insertText.value.endsWith(' = $"Sprite"'), insertText.value);
	});
});
