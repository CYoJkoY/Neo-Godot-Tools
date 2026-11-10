import { strict as assert } from "node:assert";
import { describe, it } from "node:test";
import { BindingIndex, createBindingIndex } from "./bindings";
import { createFileIndex } from "./file_index";
import { createSymbolIndex } from "./symbol_index";

function createIndex(source: string): BindingIndex {
	const files = createFileIndex();
	const symbols = createSymbolIndex(files);
	files.update("file:///player.gd", source);
	symbols.update("file:///player.gd");
	const bindings = createBindingIndex(files);
	bindings.update("file:///player.gd");
	return bindings;
}

function createWorkspace(sources: Record<string, string>): BindingIndex {
	const files = createFileIndex();
	const symbols = createSymbolIndex(files);
	const bindings = createBindingIndex(files);
	for (const [uri, source] of Object.entries(sources)) {
		files.update(uri, source);
		symbols.update(uri);
		bindings.update(uri);
	}
	return bindings;
}

const BASE_URI = "file:///base.gd";
const CHILD_URI = "file:///child.gd";
const PLAIN_BASE_URI = "file:///plain_base.gd";

describe("binding index", () => {
	it("resolves a parameter over a shadowed member", () => {
		const source = `class_name Player\nvar health: int\nfunc heal(health: int) -> void:\n\thealth += 1\n\tself.health = health\n`;
		const bindings = createIndex(source);
		const parameter = bindings.getBinding("file:///player.gd", source.indexOf("health +="), "health");
		const references = bindings.findReferences(parameter!.id);
		assert.equal(parameter?.kind, "parameter");
		assert.equal(references.length, 3);
		assert.equal(
			references.some((reference) => reference.range.start.offset === source.indexOf("self.health") + 5),
			false,
		);
	});

	it("keeps two local variables with the same name in separate functions independent", () => {
		const source = `func first() -> void:\n\tvar value = 1\n\tvalue += 1\nfunc second() -> void:\n\tvar value = 2\n\tvalue += 2\n`;
		const bindings = createIndex(source);
		const first = bindings.getBinding("file:///player.gd", source.indexOf("value += 1"), "value");
		const second = bindings.getBinding("file:///player.gd", source.indexOf("value += 2"), "value");
		assert.ok(first);
		assert.ok(second);
		assert.notEqual(first?.id, second?.id);
		assert.equal(bindings.findReferences(first!.id).length, 2);
		assert.equal(bindings.findReferences(second!.id).length, 2);
	});

	it("binds a shorthand .foo() call to the parent declaration", () => {
		const sources = {
			[BASE_URI]: "class_name Base\nfunc heal():\n\tpass\n",
			[CHILD_URI]: "class_name Child\nextends Base\nfunc heal():\n\t.heal()\n\tpass\n",
		};
		const bindings = createWorkspace(sources);
		const parent = bindings.getBinding(BASE_URI, sources[BASE_URI].indexOf("heal"), "heal");
		assert.ok(parent);
		const references = bindings.findReferences(parent.id);
		assert.equal(references.length, 2);
		assert.ok(
			references.some(
				(reference) =>
					reference.uri === CHILD_URI &&
					reference.range.start.offset === sources[CHILD_URI].indexOf(".heal()") + 1,
			),
		);
	});

	it("binds super.foo() and .foo() the same way", () => {
		const sources = {
			[BASE_URI]: "class_name Base\nfunc heal():\n\tpass\n",
			[CHILD_URI]:
				"class_name Child\nextends Base\nfunc heal():\n\tsuper.heal()\n\t.heal()\n\tpass\n",
		};
		const bindings = createWorkspace(sources);
		const parent = bindings.getBinding(BASE_URI, sources[BASE_URI].indexOf("heal"), "heal");
		assert.ok(parent);
		assert.equal(bindings.findReferences(parent.id).length, 3);
	});

	it("binds a parent script that has no class_name", () => {
		const sources = {
			[PLAIN_BASE_URI]: "extends Node\nfunc heal():\n\tpass\n",
			[CHILD_URI]: 'extends "res://plain_base.gd"\nfunc heal():\n\t.heal()\n\tpass\n',
		};
		const bindings = createWorkspace(sources);
		const parent = bindings.getBinding(PLAIN_BASE_URI, sources[PLAIN_BASE_URI].indexOf("heal"), "heal");
		assert.ok(parent);
		const references = bindings.findReferences(parent.id);
		assert.equal(references.length, 2);
		assert.ok(
			references.some(
				(reference) =>
					reference.uri === CHILD_URI &&
					reference.range.start.offset === sources[CHILD_URI].indexOf(".heal()") + 1,
			),
		);
	});
});
