import { strict as assert } from "node:assert";
import { describe, it } from "node:test";
import * as vscode from "vscode";
import { DefinitionFallback } from "../fallback/definition.js";
import { ReferencesFallback } from "../fallback/references.js";
import { RenameFallback } from "../fallback/rename.js";
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

function labelsOf(list: vscode.CompletionList | undefined): string[] {
	return (list?.items ?? []).map((item) => (typeof item.label === "string" ? item.label : item.label.label));
}

function sortTextsOf(list: vscode.CompletionList | undefined): string[] {
	return (list?.items ?? []).map((item) => item.sortText ?? "");
}

const otherUri = "file:///project/alpha_thing.gd";
const mainUri = "file:///project/main.gd";

const otherSource = `class_name AlphaThing
var zebra_value: int = 1
func zebra() -> void:
	pass
func alpha() -> void:
	pass
`;

const mainSource = `extends Node
func test() -> void:
	var zulu = 1
	var box: AlphaThing
	box.
`;

describe("completion ordering", () => {
	it("prioritizes local bindings over workspace symbols and builtins", () => {
		const service = createService();
		index(service, otherUri, otherSource);
		index(service, mainUri, mainSource);
		const result = service.semantic.getCompletions(mainUri, { offset: mainSource.indexOf("\tbox.") });
		const items = result.value ?? [];
		const zulu = items.find((item) => item.name === "zulu");
		const workspace = items.find((item) => item.name === "AlphaThing");
		const builtin = items.find((item) => item.name === "abs");
		assert.ok(zulu && workspace && builtin);
		assert.ok(
			zulu.priority < workspace.priority,
			"locals precede workspace symbols even when labels sort differently",
		);
		assert.ok(workspace.priority < builtin.priority, "workspace symbols precede builtins");
		service.dispose();
	});

	it("assigns an explicit ascending sortText to every completion", () => {
		const service = createService();
		index(service, otherUri, otherSource);
		index(service, mainUri, mainSource);
		const document = documentFor(mainUri, mainSource);
		const list = service.getCompletions(document, document.positionAt(mainSource.indexOf("\tbox.")));
		const labels = labelsOf(list);
		const sortTexts = sortTextsOf(list);
		assert.ok(labels.length > 0);
		assert.equal(new Set(sortTexts).size, sortTexts.length, "sortText values are unique");
		assert.deepEqual([...sortTexts], [...sortTexts].sort(), "sortText values match the proposed order");
		assert.equal(labels[0], "zulu", "the first suggestion stays stable although 'AlphaThing' sorts earlier");
		service.dispose();
	});

	it("keeps the first suggestion stable across repeated requests", () => {
		const service = createService();
		index(service, otherUri, otherSource);
		index(service, mainUri, mainSource);
		const document = documentFor(mainUri, mainSource);
		const position = document.positionAt(mainSource.indexOf("\tbox."));
		const first = service.getCompletions(document, position);
		const second = service.getCompletions(document, position);
		assert.deepEqual(labelsOf(second), labelsOf(first));
		assert.deepEqual(sortTextsOf(second), sortTextsOf(first));
		service.dispose();
	});

	it("orders member completions by declaration order, not alphabetically", () => {
		const service = createService();
		index(service, otherUri, otherSource);
		index(service, mainUri, mainSource);
		const document = documentFor(mainUri, mainSource);
		const list = service.getCompletions(document, document.positionAt(mainSource.length - 1));
		assert.deepEqual(labelsOf(list), ["zebra_value", "zebra", "alpha"]);
		assert.deepEqual(sortTextsOf(list), ["000000", "000001", "000002"]);
		service.dispose();
	});
});
