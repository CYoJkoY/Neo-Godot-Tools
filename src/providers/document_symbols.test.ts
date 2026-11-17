import { strict as assert } from "node:assert";
import { describe, it } from "node:test";
import * as vscode from "vscode";
import { DefinitionFallback } from "../fallback/definition.js";
import { ReferencesFallback } from "../fallback/references.js";
import { RenameFallback } from "../fallback/rename.js";
import { LanguageService } from "../language/service.js";
import type { GDDocumentSymbolProvider } from "./document_symbols.js";
import { createDocumentSymbolProvider } from "./document_symbols.js";

interface StubSurface {
	__documentSymbolProviders: Array<{ selector: unknown; provider: unknown }>;
}

const stub = vscode as unknown as StubSurface;

function fakeDocument(file: string, source: string): vscode.TextDocument {
	const lineStarts = [0];
	for (let index = 0; index < source.length; index++) if (source[index] === "\n") lineStarts.push(index + 1);
	const positionAt = (offset: number): vscode.Position => {
		const line = lineStarts.reduce((found, start, index) => (start <= offset ? index : found), 0);
		return new vscode.Position(line, offset - lineStarts[line]);
	};
	const offsetAt = (position: vscode.Position): number => lineStarts[position.line] + position.character;
	return {
		uri: vscode.Uri.file(file),
		fileName: file,
		languageId: "gdscript",
		version: 1,
		getText: (range?: vscode.Range) => (range ? source.slice(offsetAt(range.start), offsetAt(range.end)) : source),
		offsetAt,
		positionAt,
		lineAt: (lineOrPosition: number | vscode.Position) => {
			const line = typeof lineOrPosition === "number" ? lineOrPosition : lineOrPosition.line;
			return {
				lineNumber: line,
				text: source.split("\n")[line] ?? "",
				range: new vscode.Range(line, 0, line, 0),
			};
		},
		getWordRangeAtPosition: () => undefined,
	} as unknown as vscode.TextDocument;
}

const token = {
	isCancellationRequested: false,
	onCancellationRequested: () => ({ dispose: () => {} }),
} as unknown as vscode.CancellationToken;

async function outline(
	source: string,
	file = "/game/player.gd",
): Promise<{ symbols: vscode.DocumentSymbol[]; document: vscode.TextDocument; service: LanguageService }> {
	const service = new LanguageService(new DefinitionFallback(), new ReferencesFallback(), new RenameFallback());
	const document = fakeDocument(file, source);
	const provider: GDDocumentSymbolProvider = createDocumentSymbolProvider(
		{ subscriptions: [] } as unknown as vscode.ExtensionContext,
		{ languageService: service },
	);
	const symbols = (await provider.provideDocumentSymbols(document, token)) as vscode.DocumentSymbol[];
	return { symbols, document, service };
}

function names(symbols: readonly vscode.DocumentSymbol[]): string[] {
	return symbols.map((symbol) => symbol.name);
}

function textAt(document: vscode.TextDocument, range: vscode.Range): string {
	return document.getText(
		new vscode.Range(
			new vscode.Position(range.start.line, range.start.character),
			new vscode.Position(range.end.line, range.end.character),
		),
	);
}

function find(symbols: readonly vscode.DocumentSymbol[], name: string): vscode.DocumentSymbol | undefined {
	return symbols.find((symbol) => symbol.name === name);
}

describe("document symbols", () => {
	it("registers for GDScript and releases the registration on disposal", () => {
		const context = { subscriptions: [] } as unknown as vscode.ExtensionContext;
		const service = new LanguageService(new DefinitionFallback(), new ReferencesFallback(), new RenameFallback());
		try {
			const provider = createDocumentSymbolProvider(context, { languageService: service });
			assert.equal(stub.__documentSymbolProviders.length, 1);
			assert.deepEqual(stub.__documentSymbolProviders[0].selector, { language: "gdscript", scheme: "file" });
			assert.equal(stub.__documentSymbolProviders[0].provider, provider);
			context.subscriptions.map((subscription) => subscription.dispose());
			assert.equal(stub.__documentSymbolProviders.length, 0);
		} finally {
			service.dispose();
		}
	});

	it("nests inner-class members under their class", async () => {
		const source = [
			"extends Node",
			"",
			"class Worker:",
			"\tvar speed: float = 1.0",
			"",
			"\tfunc run() -> void:",
			"\t\tpass",
			"",
			"func _ready() -> void:",
			"\tpass",
		].join("\n");
		const { symbols, service } = await outline(source);
		try {
			assert.deepEqual(names(symbols), ["Worker", "_ready"]);
			const worker = find(symbols, "Worker");
			assert.deepEqual(names(worker?.children ?? []), ["speed", "run"]);
		} finally {
			service.dispose();
		}
	});

	it("keeps the script class name and top-level members at the root", async () => {
		const source = ["class_name Player", "extends Node", "var health: int", "func heal() -> void:", "\tpass"].join(
			"\n",
		);
		const { symbols, service } = await outline(source);
		try {
			assert.deepEqual(names(symbols), ["Player", "health", "heal"]);
			assert.ok(symbols.every((symbol) => symbol.children.length === 0));
		} finally {
			service.dispose();
		}
	});

	it("selects exactly the declared name inside the symbol range", async () => {
		const source = "class Worker:\n\tvar speed: int = 3\n\n\tfunc run(speed: int) -> void:\n\t\tpass\n";
		const { symbols, document, service } = await outline(source);
		try {
			const worker = find(symbols, "Worker");
			const run = find(worker?.children ?? [], "run");
			assert.ok(worker && run);
			assert.equal(textAt(document, worker.selectionRange), "Worker");
			assert.equal(textAt(document, run.selectionRange), "run");
			const start = document.offsetAt(worker.selectionRange.start);
			const end = document.offsetAt(worker.selectionRange.end);
			assert.equal(start, source.indexOf("Worker"));
			assert.equal(end, start + "Worker".length);
			assert.ok(document.offsetAt(run.range.start) <= document.offsetAt(run.selectionRange.start));
			assert.ok(document.offsetAt(run.range.end) >= document.offsetAt(run.selectionRange.end));
		} finally {
			service.dispose();
		}
	});

	it("spans a function body that contains a blank line", async () => {
		const source = ["func with_blank() -> void:", "\tvar before := 1", "", "\tvar after := 2", ""].join("\n");
		const { symbols, document, service } = await outline(source);
		try {
			const symbol = find(symbols, "with_blank");
			assert.ok(symbol);
			assert.equal(symbol.selectionRange.start.line, 0);
			assert.equal(symbol.range.start.line, 0);
			assert.ok(
				document.offsetAt(symbol.range.end) >= source.indexOf("var after := 2") + "var after := 2".length,
				"the symbol range must reach the end of the statement after the blank line",
			);
			const body = document.getText(
				new vscode.Range(
					new vscode.Position(symbol.range.start.line, symbol.range.start.character),
					new vscode.Position(symbol.range.end.line, symbol.range.end.character),
				),
			);
			assert.ok(body.includes("var after"), `range must cover the statement after the blank line: ${body}`);
		} finally {
			service.dispose();
		}
	});

	it("reports enum members as EnumMember children of the enum", async () => {
		const source = ["class Player:", "\tenum State {", "\t\tIdle,", "\t\tBusy,", "\t}", ""].join("\n");
		const { symbols, service } = await outline(source);
		try {
			const player = find(symbols, "Player");
			const state = find(player?.children ?? [], "State");
			assert.equal(state?.kind, vscode.SymbolKind.Enum);
			assert.deepEqual(names(state?.children ?? []), ["Idle", "Busy"]);
			assert.ok(state?.children.every((member) => member.kind === vscode.SymbolKind.EnumMember));
			assert.deepEqual(names(symbols), ["Player"]);
		} finally {
			service.dispose();
		}
	});

	it("shows a function signature as the outline detail", async () => {
		const source = "func heal(health: int, bonus: float = 1.5) -> bool:\n\treturn health > 0\n";
		const { symbols, service } = await outline(source);
		try {
			assert.equal(find(symbols, "heal")?.detail, "heal(health: int, bonus: float = 1.5) -> bool");
		} finally {
			service.dispose();
		}
	});

	it("keeps the declared parameters in a signal detail", async () => {
		const source = ["signal damaged(amount: int, source: Node)", "", "signal healed", ""].join("\n");
		const { symbols, service } = await outline(source);
		try {
			assert.equal(find(symbols, "damaged")?.detail, "damaged(amount: int, source: Node)");
			assert.equal(find(symbols, "healed")?.detail, "healed()");
		} finally {
			service.dispose();
		}
	});

	it("keeps the members of an unnamed enum at their declaring class", async () => {
		const source = [
			"class Player:",
			"\tenum {",
			"\t\tIdle,",
			"\t\tBusy,",
			"\t}",
			"",
			"\tfunc idle() -> void:",
			"\t\tpass",
		].join("\n");
		const { symbols, service } = await outline(source);
		try {
			const player = find(symbols, "Player");
			assert.deepEqual(names(symbols), ["Player"]);
			assert.deepEqual(names(player?.children ?? []), ["Idle", "Busy", "idle"]);
		} finally {
			service.dispose();
		}
	});

	it("rebuilds the outline from the edited text", async () => {
		const service = new LanguageService(new DefinitionFallback(), new ReferencesFallback(), new RenameFallback());
		try {
			const file = "/game/editing.gd";
			const stale = "func heal() -> void:\n\tpass\n";
			const fresh = "func heal_all() -> void:\n\tpass\n\nfunc restore() -> void:\n\tpass\n";
			await service.ensureDocumentIndexed(fakeDocument(file, stale));
			const provider = createDocumentSymbolProvider({ subscriptions: [] } as unknown as vscode.ExtensionContext, {
				languageService: service,
			});
			const symbols = (await provider.provideDocumentSymbols(fakeDocument(file, fresh), token)) as
				| vscode.DocumentSymbol[]
				| undefined;
			assert.deepEqual(names(symbols ?? []), ["heal_all", "restore"]);
		} finally {
			service.dispose();
		}
	});
});
