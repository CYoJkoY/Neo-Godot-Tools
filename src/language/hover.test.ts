import { strict as assert } from "node:assert";
import { describe, it } from "node:test";
import * as vscode from "vscode";
import { DefinitionFallback } from "../fallback/definition.js";
import { ReferencesFallback } from "../fallback/references.js";
import { RenameFallback } from "../fallback/rename.js";
import { GDHoverProvider } from "../providers/hover.js";
import { LanguageService } from "./service.js";

function createService(): LanguageService {
	return new LanguageService(new DefinitionFallback(), new ReferencesFallback(), new RenameFallback());
}

/** Mirrors `LanguageService.updateText`, which is the only in-editor entry point. */
function index(service: LanguageService, uri: string, source: string): void {
	service.files.update(uri, source, 1);
	service.dependencies.update(uri);
	service.symbols.update(uri);
	service.references.update(uri);
	service.bindings.update(uri);
	service.types.invalidate([uri]);
	service.semantic.invalidate([uri]);
}

function documentFor(uri: string, source: string): vscode.TextDocument {
	const parsed = vscode.Uri.parse(uri);
	const positionAt = (offset: number): vscode.Position => {
		const bounded = Math.max(0, Math.min(offset, source.length));
		const before = source.slice(0, bounded);
		const lineBreak = before.lastIndexOf("\n");
		return new vscode.Position((before.match(/\n/g) ?? []).length, bounded - (lineBreak + 1));
	};
	const offsetAt = (position: vscode.Position): number => {
		let offset = 0;
		for (let line = 0; line < position.line; line++) offset = source.indexOf("\n", offset) + 1;
		return Math.min(offset + position.character, source.length);
	};
	return {
		uri: parsed,
		fileName: parsed.fsPath,
		languageId: "gdscript",
		version: 1,
		getText: (range?: vscode.Range) => (range ? source.slice(offsetAt(range.start), offsetAt(range.end)) : source),
		offsetAt,
		positionAt,
		getWordRangeAtPosition: (position: vscode.Position) => {
			const offset = offsetAt(position);
			let start = offset;
			let end = offset;
			while (start > 0 && /[A-Za-z0-9_]/.test(source[start - 1])) start--;
			while (end < source.length && /[A-Za-z0-9_]/.test(source[end])) end++;
			if (start === end) return undefined;
			return new vscode.Range(positionAt(start), positionAt(end));
		},
	} as unknown as vscode.TextDocument;
}

function markdownOf(hover: vscode.Hover | undefined): string | undefined {
	if (!hover) return undefined;
	return hover.contents.map((content) => (typeof content === "string" ? content : content.value)).join("\n");
}

function hoverMarkdown(service: LanguageService, uri: string, source: string, offset: number): string | undefined {
	const document = documentFor(uri, source);
	return markdownOf(service.getHover(document, document.positionAt(offset)));
}

const playerUri = "file:///project/player.gd";
const mainUri = "file:///project/main.gd";

const playerSource = `class_name Player
## Current health points.
var health: int = 10

## Restores health over time.
func heal() -> void:
	pass
`;

const mainSource = `extends Node
var player: Player
func test() -> void:
	player.heal()
	print(player.health)
`;

describe("GDscript hover documentation", () => {
	it("renders the docstring of a function together with its signature", () => {
		const service = createService();
		const source = `extends Node
## Heals the player over time.
## Second documentation line.
func heal(amount: int = 5) -> void:
	pass
`;
		index(service, mainUri, source);
		const markdown = hoverMarkdown(service, mainUri, source, source.indexOf("heal(amount"));
		assert.ok(markdown);
		assert.match(markdown, /heal\(amount: int = 5\) -> void/);
		assert.match(markdown, /Heals the player over time\./);
		assert.match(markdown, /Second documentation line\./);
		service.dispose();
	});

	it("renders the docstring of a method resolved through a typed receiver", () => {
		const service = createService();
		index(service, playerUri, playerSource);
		index(service, mainUri, mainSource);
		const markdown = hoverMarkdown(service, mainUri, mainSource, mainSource.indexOf("heal()"));
		assert.ok(markdown);
		assert.match(markdown, /heal\(\) -> void/);
		assert.match(markdown, /Restores health over time\./);
		service.dispose();
	});

	it("renders the docstring of a property reached through a member access", () => {
		const service = createService();
		index(service, playerUri, playerSource);
		index(service, mainUri, mainSource);
		const markdown = hoverMarkdown(service, mainUri, mainSource, mainSource.indexOf("health)"));
		assert.ok(markdown);
		assert.match(markdown, /health: int/);
		assert.match(markdown, /Current health points\./);
		service.dispose();
	});

	it("renders the docstring when hovering the declaration of a variable", () => {
		const service = createService();
		index(service, playerUri, playerSource);
		const markdown = hoverMarkdown(service, playerUri, playerSource, playerSource.indexOf("health: int"));
		assert.ok(markdown);
		assert.match(markdown, /Current health points\./);
		service.dispose();
	});

	it("attaches docstrings to annotated declarations", () => {
		const service = createService();
		const source = `extends Node
## Movement speed in pixels per second.
@export_range(0.0, 100.0) var speed := 50.0
`;
		index(service, mainUri, source);
		const markdown = hoverMarkdown(service, mainUri, source, source.indexOf("speed :="));
		assert.ok(markdown);
		assert.match(markdown, /speed/);
		assert.match(markdown, /Movement speed in pixels per second\./);
		service.dispose();
	});

	it("keeps builtin hover descriptions intact", () => {
		const service = createService();
		const source = `extends Node
func test() -> void:
	print(abs(-1))
`;
		index(service, mainUri, source);
		const markdown = hoverMarkdown(service, mainUri, source, source.indexOf("abs("));
		assert.ok(markdown);
		assert.match(markdown, /abs\(/);
		assert.ok(markdown.length > "abs(".length);
		service.dispose();
	});

	it("invalidates a cached hover when only the docstring changes", () => {
		const service = createService();
		const before = `extends Node
## Heals the player.
func heal() -> void:
	pass
`;
		const after = before.replace("Heals the player.", "Heals the target.");
		assert.equal(before.length, after.length);
		index(service, mainUri, before);
		const offset = before.indexOf("heal()");
		assert.match(hoverMarkdown(service, mainUri, before, offset) ?? "", /Heals the player\./);

		// Same offsets, same length: only the semantic snapshot can notice the edit.
		service.files.update(mainUri, after, 2);
		const document = documentFor(mainUri, after);
		const markdown = markdownOf(service.getHover(document, document.positionAt(offset))) ?? "";
		assert.match(markdown, /Heals the target\./);
		assert.doesNotMatch(markdown, /Heals the player\./);
		service.dispose();
	});

	it("prefers the local hover and falls back to the language server without local information", async () => {
		const service = createService();
		const source = `extends Node
## Heals the player.
func heal() -> void:
	pass
`;
		index(service, mainUri, source);
		const fallbackCalls: string[] = [];
		const fallback = {
			provide: async () => {
				fallbackCalls.push("lsp");
				return new vscode.Hover(new vscode.MarkdownString("from language server"));
			},
		};
		const provider = new GDHoverProvider(
			{ subscriptions: [] } as unknown as vscode.ExtensionContext,
			service,
			fallback as never,
		);
		const document = documentFor(mainUri, source);
		const token = { isCancellationRequested: false } as vscode.CancellationToken;

		const local = await provider.provideHover(document, document.positionAt(source.indexOf("heal()")), token);
		const localMarkdown = markdownOf(local) ?? "";
		assert.match(localMarkdown, /Heals the player\./);
		assert.equal(fallbackCalls.length, 0);

		const indentation = source.lastIndexOf("\t");
		const miss = await provider.provideHover(document, document.positionAt(indentation), token);
		assert.equal(fallbackCalls.length, 1);
		assert.equal(markdownOf(miss), "from language server");
		service.dispose();
	});
});
