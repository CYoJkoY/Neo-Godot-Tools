import { strict as assert } from "node:assert";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { describe, it } from "node:test";
import * as vscode from "vscode";
import {
	diagnosticsEnabled,
	formatPropertyValue,
	getOpenIn,
	resolveResourceUri,
	ResourceInspectorProvider,
	ResourceModel,
} from "./provider.js";

const configuration = (vscode as unknown as { __configuration: Record<string, unknown> }).__configuration;

function withSetting(key: string, value: unknown, run: () => Promise<void>): Promise<void> {
	const previous = configuration[key];
	configuration[key] = value;
	return run().finally(() => {
		configuration[key] = previous;
	});
}

function withConfiguration(value: unknown, run: () => Promise<void>): Promise<void> {
	return withSetting("neoGodotTools.resource.inspector.openIn", value, run);
}

function makeDocument(uri: vscode.Uri, text: string): vscode.TextDocument {
	return {
		uri,
		languageId: uri.path.endsWith(".tres") ? "gdresource" : "gdscript",
		version: 1,
		isDirty: false,
		lineCount: text.split(/\r?\n/).length,
		getText: () => text,
		lineAt: (line: number) => ({
			text: text.split(/\r?\n/)[line] ?? "",
			lineNumber: line,
			range: new vscode.Range(line, 0, line, (text.split(/\r?\n/)[line] ?? "").length),
		}),
		offsetAt: () => 0,
		positionAt: () => new vscode.Position(0, 0),
		getWordRangeAtPosition: () => undefined,
	} as unknown as vscode.TextDocument;
}

describe("resource inspector provider", () => {
	it("declares the sidebar view as a webview in package.json", () => {
		const pkgPath = path.resolve(__dirname, "..", "..", "package.json");
		const pkg = JSON.parse(fs.readFileSync(pkgPath, "utf8"));
		const views = pkg.contributes?.views?.neoGodotTools ?? [];
		const inspectorView = views.find((view: { id: string }) => view.id === "neoGodotTools.resourceInspector");
		assert.ok(inspectorView, "neoGodotTools.resourceInspector view must be contributed");
		assert.equal(inspectorView.type, "webview", "sidebar view must have type='webview' so VS Code invokes registerWebviewViewProvider");
	});

	it("opens in the configured location", async () => {
		const context = { subscriptions: [], extensionUri: vscode.Uri.file(os.homedir()) } as unknown as vscode.ExtensionContext;
		const provider = new ResourceInspectorProvider(context);
		const uri = vscode.Uri.file(path.join(os.tmpdir(), "thing.tres"));

		const calls: Array<{ command: string; args: unknown[] }> = [];
		const executeCommand = vscode.commands.executeCommand;
		(vscode.commands as { executeCommand: unknown }).executeCommand = async (command: string, ...args: unknown[]) => {
			calls.push({ command, args });
		};
		try {
			await withConfiguration("editor", () => provider.openResourceInspector(uri));
			assert.equal(calls[0].command, "vscode.openWith");
			assert.equal(calls[0].args[0], uri);
			assert.equal(calls[0].args[1], "neoGodotTools.resourceInspector");

			await withConfiguration("panel", () => provider.openResourceInspector(uri));
			assert.equal(calls[1].command, "neoGodotTools.resourceInspector.focus");
		} finally {
			(vscode.commands as { executeCommand: unknown }).executeCommand = executeCommand;
			provider.dispose();
		}
	});

	it("automatically detects opened and switched .tres files in the sidebar view", async () => {
		const root = fs.mkdtempSync(path.join(os.tmpdir(), "ngdt-auto-"));
		const firstPath = path.join(root, "first.tres");
		const secondPath = path.join(root, "second.tres");
		const firstText = `[gd_resource type="Resource" format=3]\n\n[resource]\nspeed = 3.0\n`;
		const secondText = `[gd_resource type="Resource" format=3]\n\n[resource]\nhealth = 50\n`;
		fs.writeFileSync(firstPath, firstText);
		fs.writeFileSync(secondPath, secondText);

		const firstDoc = makeDocument(vscode.Uri.file(firstPath), firstText);
		const secondDoc = makeDocument(vscode.Uri.file(secondPath), secondText);

		let activeListener: ((editor?: vscode.TextEditor) => void) | undefined;
		const prevOnActive = vscode.window.onDidChangeActiveTextEditor;
		const prevOpenDoc = vscode.workspace.openTextDocument;
		const prevActiveEditor = vscode.window.activeTextEditor;

		(vscode.window as { onDidChangeActiveTextEditor: unknown }).onDidChangeActiveTextEditor = (listener: (editor?: vscode.TextEditor) => void) => {
			activeListener = listener;
			return { dispose: () => {} };
		};
		(vscode.workspace as { openTextDocument: unknown }).openTextDocument = async (target: vscode.Uri | string) => {
			const fsPath = typeof target === "string" ? target : target.fsPath;
			return fsPath === secondPath ? secondDoc : firstDoc;
		};

		const context = { subscriptions: [], extensionUri: vscode.Uri.file(os.homedir()) } as unknown as vscode.ExtensionContext;
		const provider = new ResourceInspectorProvider(context);

		const posted: Array<{ type: string; model?: ResourceModel }> = [];
		let receiveMessage: ((msg: Record<string, unknown>) => void) | undefined;
		const mockView = {
			visible: true,
			description: undefined as string | undefined,
			webview: {
				options: {},
				html: "",
				onDidReceiveMessage: (cb: (msg: Record<string, unknown>) => void) => {
					receiveMessage = cb;
					return { dispose: () => {} };
				},
				postMessage: async (msg: { type: string; model?: ResourceModel }) => {
					posted.push(msg);
					return true;
				},
			},
			onDidChangeVisibility: () => ({ dispose: () => {} }),
		} as unknown as vscode.WebviewView;

		try {
			await provider.resolveWebviewView(mockView);
			assert.equal(posted[posted.length - 1]?.type, "empty");

			// Webview posts "ready" when no .tres is active: must respond with "empty", not hang.
			receiveMessage?.({ command: "ready" });
			await new Promise((resolve) => setTimeout(resolve, 10));
			assert.equal(posted[posted.length - 1]?.type, "empty");

			// User opens first.tres in the editor -> sidebar automatically detects it.
			const firstEditor = { document: firstDoc } as vscode.TextEditor;
			(vscode.window as { activeTextEditor: unknown }).activeTextEditor = firstEditor;
			activeListener?.(firstEditor);
			await new Promise((resolve) => setTimeout(resolve, 20));

			const firstMsg = posted[posted.length - 1];
			assert.equal(firstMsg?.type, "model");
			assert.equal(firstMsg?.model?.fileName, "first.tres");
			assert.equal(mockView.description, "first.tres");
			assert.ok(firstMsg?.model?.properties.some((prop) => prop.name === "speed" && prop.raw === "3.0"));

			// User switches to second.tres -> sidebar automatically switches to second.tres.
			const secondEditor = { document: secondDoc } as vscode.TextEditor;
			(vscode.window as { activeTextEditor: unknown }).activeTextEditor = secondEditor;
			activeListener?.(secondEditor);
			await new Promise((resolve) => setTimeout(resolve, 20));

			const secondMsg = posted[posted.length - 1];
			assert.equal(secondMsg?.type, "model");
			assert.equal(secondMsg?.model?.fileName, "second.tres");
			assert.equal(mockView.description, "second.tres");
			assert.ok(secondMsg?.model?.properties.some((prop) => prop.name === "health" && prop.raw === "50"));

			// Locking pins second.tres even when first.tres becomes active.
			await provider.lockInspector();
			assert.equal(mockView.description, "🔒 second.tres");
			(vscode.window as { activeTextEditor: unknown }).activeTextEditor = firstEditor;
			activeListener?.(firstEditor);
			await new Promise((resolve) => setTimeout(resolve, 20));
			assert.equal(posted[posted.length - 1]?.model?.fileName, "second.tres");

			// Unlocking follows the active editor (first.tres) again.
			await provider.unlockInspector();
			assert.equal(posted[posted.length - 1]?.model?.fileName, "first.tres");
		} finally {
			(vscode.window as { onDidChangeActiveTextEditor: unknown }).onDidChangeActiveTextEditor = prevOnActive;
			(vscode.workspace as { openTextDocument: unknown }).openTextDocument = prevOpenDoc;
			(vscode.window as { activeTextEditor: unknown }).activeTextEditor = prevActiveEditor;
			provider.dispose();
			fs.rmSync(root, { recursive: true, force: true });
		}
	});

	it("detects unserialized @export properties from attached and base scripts", async () => {
		const root = fs.mkdtempSync(path.join(os.tmpdir(), "ngdt-exports-"));
		try {
			fs.writeFileSync(path.join(root, "project.godot"), "[application]\n");
			fs.writeFileSync(
				path.join(root, "base_stats.gd"),
				`extends Resource\nclass_name BaseStats\n\n@export var max_hp: int = 100\n`,
			);
			fs.writeFileSync(
				path.join(root, "hero.gd"),
				`extends "res://base_stats.gd"\nclass_name Hero\n\n@export_category("Combat")\n@export var attack: int = 15 # base attack\n@export var mana: float = 50.0:\n\tset(v):\n\t\tmana = v\n@export var icon: Texture2D\n`,
			);
			const tresText = `[gd_resource type="Resource" script_class="Hero" load_steps=2 format=3]\n\n[ext_resource type="Script" path="res://hero.gd" id="1_script"]\n\n[resource]\nscript = ExtResource("1_script")\n`;
			const tresPath = path.join(root, "hero.tres");
			fs.writeFileSync(tresPath, tresText);

			const context = { subscriptions: [], extensionUri: vscode.Uri.file(os.homedir()) } as unknown as vscode.ExtensionContext;
			const provider = new ResourceInspectorProvider(context);
			try {
				const doc = makeDocument(vscode.Uri.file(tresPath), tresText);
				const model = await provider.buildModel(doc);
				const byName = new Map(model.properties.map((prop) => [prop.name, prop]));

				assert.equal(model.scriptPath, "res://hero.gd");
				assert.equal(byName.get("max_hp")?.raw, "100");
				assert.equal(byName.get("max_hp")?.definedInFile, false);
				assert.equal(byName.get("attack")?.raw, "15");
				assert.equal(byName.get("attack")?.metadata?.category, "Combat");
				assert.equal(byName.get("mana")?.raw, "50.0");
				assert.equal(byName.get("icon")?.raw, "null");
				assert.equal(byName.get("icon")?.widget.kind, "resource");
			} finally {
				provider.dispose();
			}
		} finally {
			fs.rmSync(root, { recursive: true, force: true });
		}
	});

	it("detects shader uniform parameters and multi-line shader code on ShaderMaterial", async () => {
		const shaderTres = `[gd_resource type="ShaderMaterial" load_steps=2 format=2]

[sub_resource type="Shader" id=63]
code = "shader_type canvas_item;
uniform float strength: hint_range(0., 1.) = 0.5;
uniform vec4 tint: source_color = vec4(1.0, 0.0, 0.0, 1.0);
"

[resource]
shader = SubResource( 63 )
shader_param/strength = 0.8
`;
		const context = { subscriptions: [], extensionUri: vscode.Uri.file(os.homedir()) } as unknown as vscode.ExtensionContext;
		const provider = new ResourceInspectorProvider(context);
		try {
			const doc = makeDocument(vscode.Uri.file(path.join(os.tmpdir(), "shader_mat.tres")), shaderTres);
			const model = await provider.buildModel(doc);
			const byName = new Map(model.properties.map((prop) => [prop.name, prop]));

			const strength = byName.get("shader_param/strength");
			assert.ok(strength);
			assert.equal(strength.raw, "0.8");
			assert.equal(strength.metadata?.defaultValue, "0.5");
			assert.equal(strength.widget.min, 0);
			assert.equal(strength.widget.max, 1);

			const tint = byName.get("shader_param/tint");
			assert.ok(tint, "unserialized shader uniform should be detected");
			assert.equal(tint.widget.kind, "color");
			assert.equal(tint.definedInFile, false);

			const shaderSub = model.subResources.find((sub) => sub.id === "63");
			const codeProp = shaderSub?.properties.find((prop) => prop.name === "code");
			assert.equal(codeProp?.widget.kind, "textarea");
		} finally {
			provider.dispose();
		}
	});

	it("reads the openIn setting defensively", async () => {
		assert.equal(getOpenIn(), "editor");
		await withConfiguration("panel", async () => assert.equal(getOpenIn(), "panel"));
		await withConfiguration("something-else", async () => assert.equal(getOpenIn(), "editor"));
	});

	it("keeps resource diagnostics off unless they are enabled", async () => {
		// The inspector edits resources; flagging them is opt-in because partial
		// metadata cannot tell a mistake from a property it does not know.
		assert.equal(diagnosticsEnabled(), false);
		await withSetting("neoGodotTools.resource.inspector.diagnostics", true, async () => {
			assert.equal(diagnosticsEnabled(), true);
		});
		await withSetting("neoGodotTools.resource.inspector.diagnostics", false, async () => {
			assert.equal(diagnosticsEnabled(), false);
		});
	});

	it("resolves res:// paths through the nearest project.godot", () => {
		const root = fs.mkdtempSync(path.join(os.tmpdir(), "ngdt-tres-"));
		try {
			fs.writeFileSync(path.join(root, "project.godot"), "[application]\n");
			fs.mkdirSync(path.join(root, "assets"));
			fs.writeFileSync(path.join(root, "assets", "icon.svg"), "<svg/>");
			fs.mkdirSync(path.join(root, "resources"));
			const resource = vscode.Uri.file(path.join(root, "resources", "hero.tres"));

			assert.equal(resolveResourceUri(resource, "res://assets/icon.svg")?.fsPath, path.join(root, "assets", "icon.svg"));
			assert.equal(resolveResourceUri(resource, "../assets/icon.svg")?.fsPath, path.join(root, "assets", "icon.svg"));
		} finally {
			fs.rmSync(root, { recursive: true, force: true });
		}
	});

	it("formats property values back to Godot syntax", () => {
		assert.equal(formatPropertyValue("Vector2(1, 2)"), "Vector2(1, 2)");
		assert.equal(formatPropertyValue("  3.0  "), "3.0");
		assert.equal(formatPropertyValue('&"Hero"'), '&"Hero"');
	});
});
