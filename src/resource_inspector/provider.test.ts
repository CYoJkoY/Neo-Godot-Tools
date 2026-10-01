import { strict as assert } from "node:assert";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { describe, it } from "node:test";
import * as vscode from "vscode";
import { diagnosticsEnabled, formatPropertyValue, getOpenIn, resolveResourceUri, ResourceInspectorProvider } from "./provider.js";

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

describe("resource inspector provider", () => {
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
