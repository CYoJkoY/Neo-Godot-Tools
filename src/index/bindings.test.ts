import { describe, expect, it } from "vitest";
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
		expect(parameter?.kind).toBe("parameter");
		expect(references).toHaveLength(3);
		expect(references.some((reference) => reference.range.start.offset === source.indexOf("self.health") + 5)).toBe(false);
	});

	it("keeps two local variables with the same name in separate functions independent", () => {
		const source = `func first() -> void:\n\tvar value = 1\n\tvalue += 1\nfunc second() -> void:\n\tvar value = 2\n\tvalue += 2\n`;
		const bindings = createIndex(source);
		const first = bindings.getBinding("file:///player.gd", source.indexOf("value += 1"), "value");
		const second = bindings.getBinding("file:///player.gd", source.indexOf("value += 2"), "value");
		expect(first).toBeDefined();
		expect(second).toBeDefined();
		expect(first?.id).not.toBe(second?.id);
		expect(bindings.findReferences(first!.id)).toHaveLength(2);
		expect(bindings.findReferences(second!.id)).toHaveLength(2);
	});
});
