import { strict as assert } from "node:assert";
import { describe, it } from "node:test";
import { BindingIndex } from "../../index/bindings.js";
import { FileIndex } from "../../index/file_index.js";
import { SymbolIndex } from "../../index/symbol_index.js";
import { TypeResolutionIndex } from "../../index/type_resolution.js";
import { SemanticQueryEngine } from "./query_engine.js";

/**
 * These tests exercise the query engine against the real indexes.
 *
 * Earlier revisions replaced the indexes with object literals; the engine then
 * passed its own plumbing but nothing about GDScript. A stub also cannot notice
 * an index API change, which is how the tests kept "passing" after the receiver
 * resolution was rewritten.
 */

const URI = "file:///workspace/player.gd";

function createEngine(source: string, extra: Record<string, string> = {}) {
	const files = new FileIndex();
	const symbols = new SymbolIndex(files);
	const bindings = new BindingIndex(files);
	for (const [uri, text] of Object.entries({ [URI]: source, ...extra })) {
		files.update(uri, text, 1);
		symbols.update(uri);
		bindings.update(uri);
	}
	const types = new TypeResolutionIndex(files, symbols, bindings);
	return { engine: new SemanticQueryEngine(files, symbols, bindings, types), files, symbols, bindings, types };
}

/** Offset in the middle of the `occurrence`-th `word` of the source. */
function wordOffset(source: string, word: string, occurrence = 0): number {
	let start = -1;
	for (let index = 0; index <= occurrence; index++) start = source.indexOf(word, start + 1);
	assert.ok(start >= 0, `word ${JSON.stringify(word)} not found`);
	return start + Math.floor(word.length / 2);
}

const SOURCE = `class_name Player
extends Node

var health: int = 100

func heal(amount: int) -> void:
	health += amount
`;
const SOURCE_URI = "file:///workspace/player.gd";

describe("SemanticQueryEngine", () => {
	it("resolves a declared member to its declaration", () => {
		const { engine } = createEngine(SOURCE);
		const result = engine.getDefinition(URI, { offset: wordOffset(SOURCE, "health", 1) });
		assert.equal(result.confidence, "exact");
		assert.equal(result.value?.name, "health");
		assert.equal(result.value?.kind, "variable");
	});

	it("returns unknown confidence for a name that is not in the project", () => {
		const { engine } = createEngine("class_name Player\nfunc heal():\n\tnot_a_symbol\n");
		assert.equal(engine.getDefinition(URI, { offset: wordOffset("class_name Player\nfunc heal():\n\tnot_a_symbol\n", "not_a_symbol") }).confidence, "unknown");
	});

	it("returns partial confidence when a name is ambiguous in the workspace", () => {
		const { engine } = createEngine("extends Node\nfunc use():\n\tmove_to()\n", {
			"file:///workspace/a.gd": "class_name A\nfunc move_to():\n\tpass\n",
			"file:///workspace/b.gd": "class_name B\nfunc move_to():\n\tpass\n",
		});
		const source = "extends Node\nfunc use():\n\tmove_to()\n";
		const result = engine.getDefinition(URI, { offset: wordOffset(source, "move_to") });
		assert.equal(result.confidence, "partial");
		assert.equal(result.value, undefined);
	});

	it("reuses a cached result until the file changes", () => {
		const { engine, files, symbols, bindings } = createEngine(SOURCE);
		const offset = wordOffset(SOURCE, "health", 1);
		const first = engine.getDefinition(URI, { offset });
		assert.equal(engine.getDefinition(URI, { offset }), first, "an unchanged file must reuse its result");

		const edited = SOURCE.replace("var health: int = 100", "var health: int = 200");
		files.update(URI, edited, 2);
		symbols.update(URI);
		bindings.update(URI);
		engine.invalidate([URI]);
		assert.notEqual(engine.getDefinition(URI, { offset }), first, "an edited file must re-resolve");
	});

	it("returns members of a resolved type", () => {
		const { engine, types } = createEngine(SOURCE);
		const type = types.resolveName("Player");
		assert.ok(type);
		const members = engine.getMembers(type);
		assert.equal(members.confidence, "exact");
		assert.deepEqual(members.value?.map((symbol) => symbol.name).sort(), ["heal", "health"]);
	});

	it("completes local members before workspace symbols and builtins", () => {
		const source = "extends Node\nvar player_health := 1\nfunc use():\n\tplayer_\n";
		const { engine } = createEngine(source, {
			"file:///workspace/other.gd": "class_name Other\nvar player_count := 1\n",
		});
		// Completion looks at the word the cursor sits in: place it right after
		// the typed prefix, exactly like the editor does.
		const result = engine.getCompletions(URI, { offset: source.indexOf("player_\n") + "player_".length });
		assert.equal(result.confidence, "exact");
		const names = result.value?.map((item) => item.name) ?? [];
		assert.equal(names[0], "player_health", "locals must precede workspace symbols");
		assert.ok(names.includes("player_count"));
	});

	it("completes members of a receiver expression", () => {
		const source = "class_name Player\nclass Worker:\n\tvar speed := 1\n\tfunc run():\n\t\tpass\nfunc use():\n\tWorker.new().\n";
		const { engine } = createEngine(source);
		const result = engine.getCompletions(URI, { offset: source.lastIndexOf("Worker.new().") + "Worker.new().".length });
		assert.equal(result.confidence, "exact");
		assert.deepEqual(result.value?.map((item) => item.name).sort(), ["run", "speed"]);
	});

	it("invalidates a cached completion when the workspace candidate set changes", () => {
		const source = "extends Node\nfunc use():\n\tpla\n";
		const { engine, files, symbols, bindings } = createEngine(source, {
			"file:///workspace/other.gd": "class_name Other\nvar player_count := 1\n",
		});
		const offset = source.indexOf("pla\n") + "pla".length;
		const first = engine.getCompletions(URI, { offset });
		assert.ok(first.value?.some((item) => item.name === "player_count"));

		const other = "file:///workspace/other.gd";
		files.update(other, "class_name Other\nvar player_score := 1\n", 2);
		symbols.update(other);
		bindings.update(other);
		engine.invalidate([other]);
		const second = engine.getCompletions(URI, { offset });
		assert.notEqual(second, first);
		assert.ok(second.value?.some((item) => item.name === "player_score"));
		assert.equal(second.value?.some((item) => item.name === "player_count"), false);
	});
});

describe("SemanticQueryEngine references", () => {
	it("returns declarations and references for a bound member", () => {
		const source = "class_name Player\nvar health: int\nfunc heal():\n\thealth = 1\n";
		const { engine } = createEngine(source);
		const all = engine.getReferences(URI, { offset: wordOffset(source, "health", 1) }, true);
		assert.equal(all.confidence, "exact");
		assert.deepEqual(all.value?.map((reference) => reference.range.start.line), [1, 3]);

		const uses = engine.getReferences(URI, { offset: wordOffset(source, "health", 1) }, false);
		assert.deepEqual(uses.value?.map((reference) => reference.range.start.line), [3]);
	});
});

describe("SemanticQueryEngine hover", () => {
	it("returns the declaration for a hovered symbol", () => {
		const { engine } = createEngine(SOURCE);
		const result = engine.getHover(URI, { offset: wordOffset(SOURCE, "health", 1) });
		assert.equal(result.confidence, "exact");
		assert.equal(result.value?.name, "health");
	});
});
