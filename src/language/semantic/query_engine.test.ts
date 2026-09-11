import { describe, expect, it } from "vitest";
import { SemanticQueryEngine } from "./query_engine.js";
import type { BindingIndex, FileIndex, IndexedSymbol, SymbolIndex, TypeResolutionIndex, ResolvedType } from "../../index/index.js";

const uri = "file:///project/player.gd";
const variable: IndexedSymbol = {
	name: "player",
	kind: "variable",
	uri,
	range: { start: { offset: 0, line: 0, character: 0 }, end: { offset: 6, line: 0, character: 6 } },
	type: "Player",
};
const playerType: ResolvedType = { name: "Player", uri, symbol: variable, builtin: false };

function engineFor(source: string, options?: {
	fileSymbols?: IndexedSymbol[];
	binding?: { name: string; uri: string; declarationRange: IndexedSymbol["range"]; kind: "member" | "local" | "parameter" | "function"; type?: string };
	workspace?: IndexedSymbol[];
	resolvedType?: ResolvedType;
	members?: IndexedSymbol[];
}): SemanticQueryEngine {
	const file = { uri, version: 1, source, ast: {} as never, diagnostics: [], symbols: options?.fileSymbols ?? [variable] };
	const files = { get: () => file } as unknown as FileIndex;
	const symbols = { find: () => options?.workspace ?? [] } as unknown as SymbolIndex;
	const bindings = { getBinding: () => options?.binding } as unknown as BindingIndex;
	const types = {
		resolveReceiver: () => options?.resolvedType,
		resolveName: (name: string) => name === "Player" ? playerType : undefined,
		getMember: (_type: ResolvedType, name: string) => options?.members?.find((member) => member.name === name),
		getMembers: () => options?.members ?? [],
	} as unknown as TypeResolutionIndex;
	return new SemanticQueryEngine(files, symbols, bindings, types);
}

describe("SemanticQueryEngine", () => {
	it("returns exact confidence for a bound symbol", () => {
		const engine = engineFor("player", {
			binding: {
				name: "player",
				uri,
				declarationRange: variable.range,
				kind: "member",
				type: "Player",
			},
		});
		const result = engine.getSymbol(uri, { offset: 2 });
		expect(result.confidence).toBe("exact");
		expect(result.value?.name).toBe("player");
	});

	it("returns partial confidence for an ambiguous symbol", () => {
		const first = { ...variable, uri: "file:///project/player.gd" };
		const second = { ...variable, uri: "file:///project/enemy.gd" };
		const engine = engineFor("player", { fileSymbols: [], workspace: [first, second] });
		expect(engine.getSymbol(uri, { offset: 3 }).confidence).toBe("partial");
	});

	it("returns unknown confidence when no semantic information is available", () => {
		const engine = engineFor("unknown_name", { fileSymbols: [] });
		expect(engine.getSymbol(uri, { offset: 4 }).confidence).toBe("unknown");
	});

	it("resolves named types and exposes their members", () => {
		const member: IndexedSymbol = { ...variable, name: "move", kind: "function" };
		const engine = engineFor("Player", { members: [member] });
		const type = engine.getType(uri, { offset: 2 }, "Player");
		expect(type.confidence).toBe("exact");
		expect(engine.getMembers(type.value!).value).toEqual([member]);
	});
});
