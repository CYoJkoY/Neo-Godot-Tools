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
	binding?: { name: string; uri: string; declarationRange: IndexedSymbol["range"]; kind: "member" | "local" | "parameter" | "function"; type?: string; id?: string };
	visibleBindings?: Array<{ name: string; uri: string; declarationRange: IndexedSymbol["range"]; kind: "member" | "local" | "parameter" | "function"; type?: string; id?: string }>;
	workspace?: IndexedSymbol[];
	resolvedType?: ResolvedType;
	members?: IndexedSymbol[];
	references?: Array<{ bindingId: string; name: string; uri: string; range: IndexedSymbol["range"] }>;
}): SemanticQueryEngine {
	const file = { uri, version: 1, source, ast: {} as never, diagnostics: [], symbols: options?.fileSymbols ?? [variable] };
	const files = { get: () => file } as unknown as FileIndex;
	const symbols = {
		find: () => options?.workspace ?? [],
		workspaceSymbols: () => options?.workspace ?? [],
	} as unknown as SymbolIndex;
	const bindings = {
		getBinding: () => options?.binding,
		getVisibleBindings: () => options?.visibleBindings ?? [],
		findReferences: () => options?.references ?? [],
	} as unknown as BindingIndex;
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

	it("returns the cached symbol result until its URI is invalidated", () => {
		const engine = engineFor("player", {
			binding: {
				name: "player",
				uri,
				declarationRange: variable.range,
				kind: "member",
				type: "Player",
			},
		});
		const first = engine.getSymbol(uri, { offset: 2 });
		expect(engine.getSymbol(uri, { offset: 2 })).toBe(first);
		engine.invalidate([uri]);
		expect(engine.getSymbol(uri, { offset: 2 })).not.toBe(first);
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

	it("uses the same local resolution boundary for hover", () => {
		const engine = engineFor("player", {
			binding: {
				name: "player",
				uri,
				declarationRange: variable.range,
				kind: "member",
				type: "Player",
			},
		});
		const result = engine.getHover(uri, { offset: 2 });
		expect(result.confidence).toBe("exact");
		expect(result.value?.name).toBe("player");
	});

	it("returns exact references for a bound symbol and filters its declaration when requested", () => {
		const declaration = { bindingId: "player-binding", name: "player", uri, range: variable.range };
		const reference = { bindingId: "player-binding", name: "player", uri, range: { start: { offset: 20, line: 2, character: 0 }, end: { offset: 26, line: 2, character: 6 } } };
		const engine = engineFor("player", {
			binding: {
				id: "player-binding",
				name: "player",
				uri,
				declarationRange: variable.range,
				kind: "member",
			},
			references: [declaration, reference],
		});
		expect(engine.getReferences(uri, { offset: 2 }, true).value).toEqual([declaration, reference]);
		expect(engine.getReferences(uri, { offset: 2 }, false).value).toEqual([reference]);
	});

	it("returns local and workspace completion candidates with local names taking precedence", () => {
		const local = { ...variable, name: "player" };
		const duplicate = { ...variable, name: "player", uri: "file:///project/enemy.gd" };
		const workspace = { ...variable, name: "print_player", uri: "file:///project/util.gd" };
		const engine = engineFor("pl", {
			visibleBindings: [{ name: "player", uri, declarationRange: variable.range, kind: "local", type: "Player" }],
			workspace: [duplicate, workspace],
			fileSymbols: [local],
		});
		const result = engine.getCompletions(uri, { offset: 2 });
		expect(result.confidence).toBe("exact");
		expect(result.value?.map((item) => item.name)).toEqual(["player", "print_player"]);
	});

	it("returns cached completion results until its URI is invalidated", () => {
		const engine = engineFor("pl", {
			visibleBindings: [{ name: "player", uri, declarationRange: variable.range, kind: "local", type: "Player" }],
		});
		const first = engine.getCompletions(uri, { offset: 2 });
		expect(engine.getCompletions(uri, { offset: 2 })).toBe(first);
		engine.invalidate([uri]);
		expect(engine.getCompletions(uri, { offset: 2 })).not.toBe(first);
	});

	it("returns member completions from a resolved receiver", () => {
		const move: IndexedSymbol = { ...variable, name: "move", kind: "function" };
		const engine = engineFor("player.mo", { resolvedType: playerType, members: [move] });
		const result = engine.getCompletions(uri, { offset: 8 });
		expect(result.confidence).toBe("exact");
		expect(result.value?.map((item) => item.name)).toEqual(["move"]);
	});
});
