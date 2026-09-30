import { strict as assert } from "node:assert";
import { describe, it } from "node:test";
import { FileIndex } from "./file_index";
import { BindingIndex } from "./bindings";
import { SymbolIndex } from "./symbol_index";

function createIndex(source: string): BindingIndex {
	const files = new FileIndex();
	const symbols = new SymbolIndex(files);
	files.update("file:///player.gd", source);
	symbols.update("file:///player.gd");
	const bindings = new BindingIndex(files);
	bindings.update("file:///player.gd");
	return bindings;
}

describe("binding index", () => {
	it("resolves a parameter over a shadowed member", () => {
		const source = `class_name Player\nvar health: int\nfunc heal(health: int) -> void:\n\thealth += 1\n\tself.health = health\n`;
		const bindings = createIndex(source);
		const parameter = bindings.getBinding("file:///player.gd", source.indexOf("health +="), "health");
		const references = bindings.findReferences(parameter!.id);
		assert.equal(parameter?.kind, "parameter");
		assert.equal((references).length, 3);
		assert.equal(references.some((reference) => reference.range.start.offset === source.indexOf("self.health") + 5), false);
	});

	it("keeps two local variables with the same name in separate functions independent", () => {
		const source = `func first() -> void:\n\tvar value = 1\n\tvalue += 1\nfunc second() -> void:\n\tvar value = 2\n\tvalue += 2\n`;
		const bindings = createIndex(source);
		const first = bindings.getBinding("file:///player.gd", source.indexOf("value += 1"), "value");
		const second = bindings.getBinding("file:///player.gd", source.indexOf("value += 2"), "value");
		assert.ok(first);
		assert.ok(second);
		assert.notEqual(first?.id, second?.id);
		assert.equal((bindings.findReferences(first!.id)).length, 2);
		assert.equal((bindings.findReferences(second!.id)).length, 2);
	});
});
