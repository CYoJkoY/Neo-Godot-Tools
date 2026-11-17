import { strict as assert } from "node:assert";
import { describe, it } from "node:test";
import * as vscode from "vscode";
import { DefinitionFallback } from "../fallback/definition.js";
import { ReferencesFallback } from "../fallback/references.js";
import { RenameFallback } from "../fallback/rename.js";
import { LanguageService } from "../language/service.js";
import { createDefinitionProvider } from "./definition.js";
import type { DefinitionLspClient, NativeDocsIndex } from "./definition.js";

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

const cancellationToken = {
	isCancellationRequested: false,
	onCancellationRequested: () => ({ dispose: () => {} }),
} as unknown as vscode.CancellationToken;

const docs: NativeDocsIndex = {
	classInfo: new Map([
		["Object", { name: "Object", inherits: "" }],
		["Node", { name: "Node", inherits: "Object" }],
	]),
};

function nativeLsp(members: Record<string, string>): DefinitionLspClient {
	return {
		sendRequest: async (_method: string, params?: unknown) => {
			const query = params as { native_class?: string; symbol_name?: string } | undefined;
			const kind = query?.symbol_name ? members[query.symbol_name] : undefined;
			return kind ? { name: query?.symbol_name, kind } : null;
		},
		get_symbol_at_position: async () => undefined,
	};
}

async function definitionAt(
	service: LanguageService,
	uri: string,
	source: string,
	needle: string,
	lsp?: DefinitionLspClient,
	docsIndex: NativeDocsIndex = docs,
	offsetInNeedle = 0,
): Promise<vscode.Location | undefined> {
	const provider = createDefinitionProvider({ subscriptions: [] } as unknown as vscode.ExtensionContext, {
		languageService: service,
		docs: () => docsIndex,
		lsp: () => lsp,
	});
	const document = documentFor(uri, source);
	const offset = source.indexOf(needle) + offsetInNeedle;
	return (await provider.provideDefinition(document, document.positionAt(offset), cancellationToken)) as
		| vscode.Location
		| undefined;
}

const mainUri = "file:///project/main.gd";

describe("GDScript definition navigation", () => {
	it("opens the engine documentation of a builtin instead of a virtual symbol", async () => {
		const service = createService();
		const source = `extends Node
func test() -> void:
	print(abs(-1))
`;
		index(service, mainUri, source);

		const location = await definitionAt(service, mainUri, source, "abs(");
		assert.ok(location);
		assert.equal(location.uri.scheme, "gddoc");
		assert.equal(location.uri.path, "@GlobalScope.gddoc");
		assert.equal(location.uri.fragment, "method-abs");
		service.dispose();
	});

	it("keeps a project function that shares its name with a builtin", async () => {
		const service = createService();
		const source = `extends Node
func abs(value: int) -> int:
	return value

func test() -> void:
	print(abs(-1))
`;
		index(service, mainUri, source);

		const location = await definitionAt(service, mainUri, source, "abs(-1)");
		assert.ok(location);
		assert.equal(location.uri.toString(), mainUri);
		assert.equal(location.range.start.line, 1);
		service.dispose();
	});

	it("opens the documentation of a builtin member of a native receiver", async () => {
		const service = createService();
		const source = `extends Node
func test() -> void:
	var node: Node = self
	node.get_class()
`;
		index(service, mainUri, source);

		const location = await definitionAt(service, mainUri, source, "get_class()", nativeLsp({ get_class: "method" }));
		assert.ok(location);
		assert.equal(location.uri.scheme, "gddoc");
		assert.equal(location.uri.path, "Node.gddoc");
		assert.equal(location.uri.fragment, "method-get_class");
		service.dispose();
	});

	it("keeps the project member of a project receiver over the engine catalog", async () => {
		const service = createService();
		const uri = "file:///project/box.gd";
		const source = `class_name Box
class Inner:
	func get_class() -> String:
		return "inner"

func test(inner: Inner) -> void:
	print(inner.get_class())
`;
		index(service, uri, source);

		const location = await definitionAt(
			service,
			uri,
			source,
			"inner.get_class()",
			nativeLsp({ get_class: "method" }),
			docs,
			"inner.".length,
		);
		assert.ok(location);
		assert.equal(location.uri.toString(), uri, "a project member is never shadowed by Godot's catalog");
		assert.equal(location.range.start.line, 2, JSON.stringify(location.range));
		service.dispose();
	});
});
