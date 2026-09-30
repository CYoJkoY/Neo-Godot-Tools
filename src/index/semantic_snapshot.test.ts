import { strict as assert } from "node:assert";
import { describe, it } from "node:test";
import type { GDScriptScript } from "../analyzer/index.js";
import type { IndexedSymbol } from "./symbol.js";
import { createApiFingerprint } from "./semantic_snapshot.js";

const uri = "file:///project/player.gd";
const range = { start: { offset: 0, line: 0, character: 0 }, end: { offset: 6, line: 0, character: 6 } };

function fingerprint(source: string, symbols: readonly IndexedSymbol[], declarations: unknown[] = []): string {
	return createApiFingerprint({ declarations } as GDScriptScript, source, symbols);
}

describe("createApiFingerprint", () => {
	it("ignores function-body-only changes", () => {
		const symbol: IndexedSymbol = { name: "move", kind: "function", uri, range, returnType: "void", parameters: [] };
		assert.equal(fingerprint("func move():\n\treturn", [symbol]), fingerprint("func move():\n\tpass", [symbol]));
	});

	it("changes when a public function signature changes", () => {
		const first: IndexedSymbol = { name: "move", kind: "function", uri, range, returnType: "void", parameters: [{ name: "speed", type: "float" }] };
		const second: IndexedSymbol = { ...first, parameters: [{ name: "speed", type: "int" }] };
		assert.notEqual(fingerprint("func move(speed: float): pass", [first]), fingerprint("func move(speed: int): pass", [second]));
	});

	it("changes when inheritance changes", () => {
		const declarationsA = [{ kind: "extends", name: "Node" }];
		const declarationsB = [{ kind: "extends", name: "Control" }];
		assert.notEqual(fingerprint("extends Node", [], declarationsA), fingerprint("extends Control", [], declarationsB));
	});
});
