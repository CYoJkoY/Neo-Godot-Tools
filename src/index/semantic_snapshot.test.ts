import { describe, expect, it } from "vitest";
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
		expect(fingerprint("func move():\n\treturn", [symbol])).toBe(fingerprint("func move():\n\tpass", [symbol]));
	});

	it("changes when a public function signature changes", () => {
		const first: IndexedSymbol = { name: "move", kind: "function", uri, range, returnType: "void", parameters: [{ name: "speed", type: "float" }] };
		const second: IndexedSymbol = { ...first, parameters: [{ name: "speed", type: "int" }] };
		expect(fingerprint("func move(speed: float): pass", [first])).not.toBe(fingerprint("func move(speed: int): pass", [second]));
	});

	it("changes when inheritance changes", () => {
		const declarationsA = [{ kind: "extends", name: "Node" }];
		const declarationsB = [{ kind: "extends", name: "Control" }];
		expect(fingerprint("extends Node", [], declarationsA)).not.toBe(fingerprint("extends Control", [], declarationsB));
	});
});
