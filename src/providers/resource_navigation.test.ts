import { strict as assert } from "node:assert";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, it, mock } from "node:test";
import * as vscode from "vscode";
import { createDocumentLinkProvider, type GDDocumentLinkProvider } from "./document_link.js";
import { createHoverProvider, type GDHoverProvider } from "./hover.js";

const SCENE = `[gd_scene load_steps=2 format=3]

[ext_resource type="Script" path="res://player.gd" id="1"]

[node name="Player" type="Node2D"]
script = ExtResource("1")
`;

function positionAt(text: string, offset: number): vscode.Position {
	const before = text.slice(0, Math.max(0, Math.min(offset, text.length)));
	const lineBreak = before.lastIndexOf("\n");
	return new vscode.Position((before.match(/\n/g) ?? []).length, before.length - (lineBreak + 1));
}

function offsetAt(text: string, position: vscode.Position): number {
	let offset = 0;
	for (let line = 0; line < position.line; line++) offset = text.indexOf("\n", offset) + 1;
	return Math.min(offset + position.character, text.length);
}

/** The stub's `getWordRangeAtPosition` ignores the regex, so tests supply one. */
function wordRangeAt(text: string, offset: number, pattern: RegExp): vscode.Range | undefined {
	const flags = pattern.flags.includes("g") ? pattern.flags : `${pattern.flags}g`;
	for (const match of text.matchAll(new RegExp(pattern.source, flags))) {
		const start = match.index ?? 0;
		const end = start + match[0].length;
		if (offset >= start && offset <= end) return new vscode.Range(positionAt(text, start), positionAt(text, end));
	}
	return undefined;
}

function textDocument(file: string, text: string, languageId: string): vscode.TextDocument {
	return {
		uri: vscode.Uri.file(file),
		fileName: file,
		languageId,
		version: 1,
		getText: (range?: vscode.Range) =>
			range ? text.slice(offsetAt(text, range.start), offsetAt(text, range.end)) : text,
		offsetAt: (position: vscode.Position) => offsetAt(text, position),
		positionAt: (offset: number) => positionAt(text, offset),
		getWordRangeAtPosition: (position: vscode.Position, pattern?: RegExp) =>
			pattern ? wordRangeAt(text, offsetAt(text, position), pattern) : undefined,
		lineAt: (lineOrPosition: number | vscode.Position) => {
			const line = typeof lineOrPosition === "number" ? lineOrPosition : lineOrPosition.line;
			const lines = text.split("\n");
			return { text: lines[line] ?? "", lineNumber: line, range: new vscode.Range(line, 0, line, 0) };
		},
	} as unknown as vscode.TextDocument;
}

function markdownOf(hover: vscode.Hover | undefined): string {
	if (!hover) return "";
	return hover.contents.map((content) => (typeof content === "string" ? content : content.value)).join("\n");
}

describe("resource navigation inside a nested project", () => {
	let root: string;
	let scenePath: string;
	let hover: GDHoverProvider;
	let links: GDDocumentLinkProvider;
	let subscriptions: vscode.Disposable[];

	function write(relative: string, text: string): void {
		const file = path.join(root, relative);
		fs.mkdirSync(path.dirname(file), { recursive: true });
		fs.writeFileSync(file, text);
	}

	beforeEach(() => {
		root = fs.mkdtempSync(path.join(os.tmpdir(), "ngdt-navigation-"));
		// Both the outer workspace directory and the nested project hold a
		// player.gd, so a workspace-global lookup picks the wrong one.
		write("project.godot", "config_version=4\n");
		write("player.gd", "extends Node2D\n# outer copy\nclass_name OuterPlayer\n");
		write("game/project.godot", "config_version=4\n");
		write("game/player.gd", "extends Node2D\n# inner copy\nclass_name Player\n");
		scenePath = path.join(root, "game", "main.tscn");
		write("game/main.tscn", SCENE);
		subscriptions = [];
		mock.method(vscode.workspace, "getWorkspaceFolder", () => ({
			uri: vscode.Uri.file(root),
			name: "workspace",
			index: 0,
		}));
		// Only `.uid` scans reach `findFiles`; the scene project walk is file based.
		mock.method(vscode.workspace, "findFiles", async (include: string) =>
			include.includes(".uid")
				? [vscode.Uri.file(path.join(root, "player.gd.uid"))].filter((uri) => fs.existsSync(uri.fsPath))
				: [],
		);
		mock.method(vscode.workspace, "openTextDocument", async (uri: vscode.Uri) =>
			textDocument(uri.fsPath, fs.readFileSync(uri.fsPath, "utf8"), "gdscript"),
		);
		hover = createHoverProvider({ subscriptions } as unknown as vscode.ExtensionContext);
		links = createDocumentLinkProvider({ subscriptions } as unknown as vscode.ExtensionContext);
	});

	afterEach(() => {
		for (const subscription of subscriptions) subscription.dispose();
		mock.restoreAll();
		fs.rmSync(root, { recursive: true, force: true });
	});

	it("previews the script declared by a scene from the owning project", async () => {
		const document = textDocument(scenePath, SCENE, "gdscene");
		const result = await hover.provideHover(document, document.positionAt(SCENE.indexOf("ExtResource")), {
			isCancellationRequested: false,
		} as vscode.CancellationToken);
		const markdown = markdownOf(result);
		assert.match(markdown, /inner copy/);
		assert.doesNotMatch(markdown, /outer copy/);
		assert.match(markdown, /res:\/\/player\.gd/);
	});

	it("previews a res:// path under the cursor from the owning project", async () => {
		const source = 'extends Node2D\nconst SCRIPT = "res://player.gd"\n';
		const document = textDocument(path.join(root, "game", "player.gd"), source, "gdscript");
		const result = await hover.provideHover(document, document.positionAt(source.indexOf("res://")), {
			isCancellationRequested: false,
		} as vscode.CancellationToken);
		const markdown = markdownOf(result);
		// The document itself is the inner copy, so its hover shows that file.
		assert.match(markdown, /inner copy/);
		assert.doesNotMatch(markdown, /outer copy/);
	});

	it("links scene resources to the owning project", async () => {
		const found =
			(await links.provideDocumentLinks(textDocument(scenePath, SCENE, "gdscene"), {
				isCancellationRequested: false,
			} as vscode.CancellationToken)) ?? [];
		const targets = found
			.map((link) => link.target?.fsPath)
			.filter((target): target is string => target?.endsWith(".gd") === true);
		assert.deepEqual(
			targets.map((target) => path.normalize(target)),
			[path.normalize(path.join(root, "game", "player.gd"))],
		);
	});

	it("ignores a uid that points outside the owning project", async () => {
		// The outer project registers the uid; the inner project has no such file.
		write("player.gd.uid", "uid://outerplayer\n");
		const source = '[gd_scene format=3]\n\n[ext_resource type="Script" uid="uid://outerplayer" id="1"]\n';
		const document = textDocument(scenePath, source, "gdscene");
		const found =
			(await links.provideDocumentLinks(document, {
				isCancellationRequested: false,
			} as vscode.CancellationToken)) ?? [];
		assert.deepEqual(
			found.map((link) => link.target?.fsPath).filter((target) => target?.endsWith(".gd")),
			[],
		);
		const result = await hover.provideHover(document, document.positionAt(source.indexOf("uid://")), {
			isCancellationRequested: false,
		} as vscode.CancellationToken);
		assert.equal(result, undefined);
	});
});
