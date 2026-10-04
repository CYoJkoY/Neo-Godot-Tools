import { strict as assert } from "node:assert";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { describe, it } from "node:test";
import * as vscode from "vscode";
import { SceneParser } from "../scene_tools/index.js";
import {
	type InlayHintLsp,
	type InlayHintSource,
	createInlayHintsProvider,
	gdscriptHints,
	sceneHints,
} from "./inlay_hints.js";

function positionAt(lineStarts: number[], offset: number): vscode.Position {
	let low = 0;
	let high = lineStarts.length;
	while (low < high) {
		const middle = (low + high) >>> 1;
		if (lineStarts[middle] <= offset) low = middle + 1;
		else high = middle;
	}
	const line = Math.max(0, low - 1);
	return new vscode.Position(line, offset - lineStarts[line]);
}

function offsetAt(lineStarts: number[], position: vscode.Position): number {
	return lineStarts[position.line] + position.character;
}

/** Minimal `TextDocument`: uri, text and offset <-> position lookup. */
function fakeDocument(file: string, source: string): vscode.TextDocument {
	const lineStarts = [0];
	for (let index = 0; index < source.length; index++) if (source[index] === "\n") lineStarts.push(index + 1);
	return {
		uri: { fsPath: file, scheme: "file", toString: () => `file://${file}` },
		fileName: file,
		languageId: file.endsWith(".gd") ? "gdscript" : "gdscene",
		getText: (range?: vscode.Range) =>
			range ? source.slice(offsetAt(lineStarts, range.start), offsetAt(lineStarts, range.end)) : source,
		offsetAt: (position: vscode.Position) => offsetAt(lineStarts, position),
		positionAt: (offset: number) => positionAt(lineStarts, offset),
		lineAt: (lineOrPosition: number | { line: number }) => {
			const line = typeof lineOrPosition === "number" ? lineOrPosition : lineOrPosition.line;
			return { lineNumber: line, text: source.split("\n")[line] ?? "" };
		},
	} as unknown as vscode.TextDocument;
}

/**
 * A document the scene parser accepts: it stats the file behind the uri, so the
 * source is written to a temporary directory first.
 */
function sceneDocument(source: string, name = "scene.tscn"): { document: vscode.TextDocument; dispose: () => void } {
	const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "ngdt-inlay-")), name);
	fs.writeFileSync(file, source);
	return {
		document: fakeDocument(file, source),
		dispose: () => fs.rmSync(path.dirname(file), { recursive: true, force: true }),
	};
}

const TOKEN: vscode.CancellationToken = { isCancellationRequested: false } as vscode.CancellationToken;

type HoverRequest = { line: number; character: number };

const GDSCRIPT = 'var speed := 10\nconst NAME := "x"\n\nfunc _ready() -> void:\n\tvar tint := Color.RED\n';
const SYMBOLS = [
	{ name: "speed", detail: "var speed: int" },
	{ name: "tint" },
	{ name: "NAME" },
] as unknown as vscode.DocumentSymbol[];

/** Answers `documentSymbol` with `symbols` and `hover` through `hoverDetail`. */
function fakeClient(
	hoverDetail: (position: HoverRequest) => string | undefined,
	documentSymbols: vscode.DocumentSymbol[] = SYMBOLS,
): InlayHintSource & { calls: string[]; hovers: HoverRequest[] } {
	const calls: string[] = [];
	const hovers: HoverRequest[] = [];
	return {
		calls,
		hovers,
		isRunning: () => true,
		sendRequest: (method: string, params?: unknown): Promise<unknown> => {
			calls.push(method);
			if (method === "textDocument/documentSymbol") return Promise.resolve(documentSymbols);
			const position = (params as { position: HoverRequest }).position;
			hovers.push(position);
			return Promise.resolve({ contents: { kind: "markdown", value: hoverDetail(position) ?? "" } });
		},
	};
}

describe("inlay hints", () => {
	it("labels inferred variables from the symbol detail, then from hover", async () => {
		const document = fakeDocument("/game/player.gd", GDSCRIPT);
		// Only `speed` has a document symbol detail; `tint` is answered by hover.
		const client = fakeClient((position) => (position.line === 4 ? "var tint: Color" : undefined));
		const hints = await gdscriptHints(document, GDSCRIPT, 0, TOKEN, client);

		assert.deepEqual(
			hints.map((hint) => hint.label),
			["int", "Color"],
			"`speed` from its symbol detail, `tint` from hover, `NAME` without a type",
		);
		assert.deepEqual(
			hints.map((hint) => [hint.position.line, hint.position.character]),
			[
				[0, "var speed :=".length - 1],
				[4, "\tvar tint =".length],
			],
			"the hint sits on the `=`, before the inferred value",
		);
		assert.equal(hints[0].textEdits?.[0].newText, " int ");
		assert.deepEqual(
			client.hovers,
			[
				{ line: 1, character: "const ".length },
				{ line: 4, character: "\tvar ".length },
			],
			"one hover per declaration without a detail, on the declaration keyword",
		);
	});

	it("reads the nested document symbols godot 4 returns", async () => {
		const document = fakeDocument("/game/player.gd", GDSCRIPT);
		const nested = [{ name: "player.gd", children: SYMBOLS }] as unknown as vscode.DocumentSymbol[];
		const hints = await gdscriptHints(
			document,
			GDSCRIPT,
			0,
			TOKEN,
			fakeClient(() => undefined, nested),
		);

		assert.deepEqual(
			hints.map((hint) => hint.label),
			["int"],
			"only the declaration with a detail survives",
		);
	});

	it("does not touch the server without a client, symbols or a live request", async () => {
		const document = fakeDocument("/game/player.gd", GDSCRIPT);
		assert.deepEqual(await gdscriptHints(document, GDSCRIPT, 0, TOKEN, undefined), []);

		const empty = fakeClient(() => undefined, [] as vscode.DocumentSymbol[]);
		assert.deepEqual(await gdscriptHints(document, GDSCRIPT, 0, TOKEN, empty), []);

		const cancelled = fakeClient(() => undefined);
		assert.deepEqual(
			await gdscriptHints(
				document,
				GDSCRIPT,
				0,
				{ isCancellationRequested: true } as vscode.CancellationToken,
				cancelled,
			),
			[],
		);
		assert.deepEqual(
			cancelled.calls,
			["textDocument/documentSymbol"],
			"a cancelled request never asks for a hover",
		);
		assert.deepEqual(cancelled.hovers, []);
	});

	it("labels scene resources and sub-resources", () => {
		const scene = [
			"[gd_scene load_steps=3 format=3]",
			'[ext_resource type="Script" path="res://player.gd" id="1_abc"]',
			'[sub_resource type="RectangleShape2D" id="RectangleShape2D_1"]',
			"size = Vector2(32, 32)",
			'[node name="Player" type="CharacterBody2D"]',
			'script = ExtResource("1_abc")',
			'shape = SubResource("RectangleShape2D_1")',
			"",
		].join("\n");
		const { document, dispose } = sceneDocument(scene);
		const hints = sceneHints(document, scene, 0, new SceneParser());

		assert.deepEqual(
			hints.map((hint) => hint.label),
			['Script: "res://player.gd"', "RectangleShape2D"],
		);
		assert.deepEqual(
			hints.map((hint) => [hint.position.line, hint.position.character]),
			[
				[5, 'script = ExtResource("1_abc")'.length],
				[6, 'shape = SubResource("RectangleShape2D_1")'.length],
			],
		);
		dispose();
	});

	it("registers itself and refreshes after the handshake", async () => {
		const statuses: Array<(status: number) => unknown> = [];
		const lsp: InlayHintLsp = {
			client: fakeClient(() => undefined),
			onStatusChanged: (listener) => {
				statuses.push(listener);
				return { dispose: () => {} };
			},
		};
		const context = { subscriptions: [] as Array<{ dispose(): void }> };
		const provider = createInlayHintsProvider(context as unknown as vscode.ExtensionContext, {
			lsp: () => lsp,
			refreshDelayMs: 1,
		});
		const changed: string[] = [];
		provider.onDidChangeInlayHints(() => changed.push(`refresh ${changed.length}`));

		assert.equal(context.subscriptions.length, 2, "the provider and its registration are tracked");

		const scene = 'x = ExtResource("1_abc")\n';
		const { document, dispose } = sceneDocument(scene);
		const hints =
			(await provider.provideInlayHints(
				document,
				new vscode.Range(new vscode.Position(0, 0), new vscode.Position(1, 0)),
				TOKEN,
			)) ?? [];
		assert.equal(hints.length, 1);
		assert.equal(hints[0].label, 'undefined: "undefined"', "an id without a resource resolves to undefined");

		statuses.map((listener) => listener(5));
		await new Promise((resolve) => setTimeout(resolve, 10));
		assert.equal(changed.length, 2, "the connected status fires immediately and once more after the delay");
		provider.dispose();
		dispose();
	});
});
