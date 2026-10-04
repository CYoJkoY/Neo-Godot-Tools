import { strict as assert } from "node:assert";
import { describe, it } from "node:test";
import { parseGDScript } from "../analyzer/index.js";
import { SemanticQueryEngine } from "../language/semantic/query_engine.js";
import {
	FileIndex,
	SymbolIndex,
	TypeResolutionIndex,
	createBindingIndex,
	createDependencyGraph,
	createFileIndex,
	createSymbolIndex,
	createTypeResolutionIndex,
} from "./index.js";

const uri = "file:///project/atype_test.gd";

const source = `extends Node
enum AtypeTest { O, OQ, OW, OP, OD }

enum { HIDDEN_A, HIDDEN_B = 4 }

var unrelated: int = 1

func pick() -> AtypeTest:
	return AtypeTest.O

func chosen() -> void:
	var selection = AtypeTest.O

func complete_here() -> void:
	var value = AtypeTest.
`;

function createIndices(): {
	files: FileIndex;
	symbols: SymbolIndex;
	types: TypeResolutionIndex;
	engine: SemanticQueryEngine;
} {
	const files = createFileIndex();
	const symbols = createSymbolIndex(files);
	const bindings = createBindingIndex(files);
	const types = createTypeResolutionIndex(files, symbols, bindings);
	const dependencies = createDependencyGraph(files);
	files.update(uri, source, 1);
	symbols.update(uri);
	bindings.update(uri);
	dependencies.update(uri);
	return { files, symbols, types, engine: new SemanticQueryEngine(files, symbols, bindings, types) };
}

/** Offset just after the trailing `AtypeTest.` of `complete_here`. */
const completionOffset = source.lastIndexOf("AtypeTest.") + "AtypeTest.".length;

describe("named enum members", () => {
	it("parses members with their own ranges and values", () => {
		const parsed = parseGDScript("enum Values { A = 1, B = 2, C = A | 4 }\n");
		assert.deepEqual(parsed.diagnostics, []);
		const declaration = parsed.ast.declarations[0];
		assert.equal(declaration.kind, "enum");
		if (declaration.kind !== "enum") return;
		assert.equal(declaration.name, "Values");
		assert.deepEqual(
			declaration.members.map((member) => member.name),
			["A", "B", "C"],
		);
		assert.deepEqual(
			declaration.members.map((member) => member.value),
			["1", "2", "A | 4"],
		);
		const text = "enum Values { A = 1, B = 2, C = A | 4 }\n";
		for (const member of declaration.members) {
			assert.equal(text.slice(member.range.start.offset, member.range.end.offset), member.name);
		}
	});

	it("indexes enum members as symbols scoped to the enum", () => {
		const { files } = createIndices();
		const symbols = files.get(uri)?.symbols ?? [];
		const enumSymbol = symbols.find((symbol) => symbol.kind === "enum" && symbol.name === "AtypeTest");
		assert.ok(enumSymbol);
		const members = symbols.filter(
			(symbol) => symbol.kind === "enum_member" && symbol.containerName === "AtypeTest",
		);
		assert.deepEqual(
			members.map((symbol) => symbol.name),
			["O", "OQ", "OW", "OP", "OD"],
		);
		assert.deepEqual(
			members.map((symbol) => symbol.type),
			["AtypeTest", "AtypeTest", "AtypeTest", "AtypeTest", "AtypeTest"],
		);

		const hidden = symbols.filter((symbol) => symbol.kind === "enum_member" && symbol.name.startsWith("HIDDEN"));
		assert.deepEqual(
			hidden.map((symbol) => symbol.name),
			["HIDDEN_A", "HIDDEN_B"],
		);
		assert.deepEqual(
			hidden.map((symbol) => symbol.containerName),
			[undefined, undefined],
		);
	});

	it("treats a named enum as a type exposing exactly its members", () => {
		const { types } = createIndices();
		const enumType = types.resolveName("AtypeTest");
		assert.ok(enumType);
		assert.equal(enumType.uri, uri);
		assert.equal(enumType.builtin, false);
		assert.equal(enumType.symbol?.kind, "enum");
		assert.deepEqual(
			types.getMembers(enumType).map((member) => member.name),
			["O", "OQ", "OW", "OP", "OD"],
		);
		assert.equal(types.resolveReceiver(uri, completionOffset, "AtypeTest")?.name, "AtypeTest");
		assert.equal(types.resolveName("unrelated"), undefined);
	});

	it("completes exactly the enum members after `EnumName.`", () => {
		const { engine } = createIndices();
		const result = engine.getCompletions(uri, { offset: completionOffset });
		assert.equal(result.confidence, "exact");
		assert.deepEqual(
			result.value?.map((item) => item.name),
			["O", "OQ", "OW", "OP", "OD"],
		);
		assert.ok(result.value?.every((item) => item.kind === "enum_member"));
	});

	it("does not leak scoped enum members into global completion", () => {
		const { engine } = createIndices();
		const result = engine.getCompletions(uri, { offset: source.lastIndexOf("\tvar value =") });
		const names = result.value?.map((item) => item.name) ?? [];
		assert.ok(names.includes("HIDDEN_A"), "members of unnamed enums stay script constants");
		assert.ok(names.includes("unrelated"));
		assert.ok(!names.includes("O"));
		assert.ok(!names.includes("OQ"));
	});

	it("reuses the enum-member symbol for hover and definition", () => {
		const { engine } = createIndices();
		const offset = source.indexOf("AtypeTest.O", source.indexOf("return AtypeTest.O")) + "AtypeTest.".length;
		const hover = engine.getHover(uri, { offset });
		assert.equal(hover.value?.name, "O");
		assert.equal(hover.value?.kind, "enum_member");
		assert.equal(hover.value?.containerName, "AtypeTest");
		const definition = engine.getDefinition(uri, { offset });
		assert.equal(definition.value?.name, "O");
		assert.ok(
			definition.value && definition.value.range.start.offset < offset,
			"definition points at the declaration",
		);
		assert.equal(source.slice(definition.value!.range.start.offset, definition.value!.range.end.offset), "O");
	});

	it("resolves the expression type of `EnumName.Member` to the enum", () => {
		const { engine } = createIndices();
		const offset = source.indexOf("selection");
		const type = engine.getType(uri, { offset }, "selection");
		assert.equal(type.value?.name, "AtypeTest");
		assert.equal(type.value?.builtin, false);
	});
});
