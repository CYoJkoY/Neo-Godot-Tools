import { strict as assert } from "node:assert";
import { describe, it } from "node:test";
import { createFileIndex } from "./file_index";
import { collectReferences, createReferenceIndex } from "./references";
import { createSymbolIndex } from "./symbol_index";

const source = `class_name Player
var health: int
func heal(amount: int) -> void:
\thealth += amount
\thealth = clamp(health, 0, 100)
`;

describe("reference index", () => {
	it("collects code identifiers but not comments or strings", () => {
		const references = collectReferences(`${source}\n# health health\nvar label = "health"\n`, "file:///player.gd");
		assert.equal(references.filter((reference) => reference.name === "health").length, 4);
		assert.equal(
			references.some((reference) => reference.name === "amount"),
			true,
		);
		assert.equal(
			references.some((reference) => reference.name === "class_name"),
			false,
		);
	});

	it("replaces references incrementally with the file", () => {
		const files = createFileIndex();
		const symbols = createSymbolIndex(files);
		const references = createReferenceIndex(files);
		files.update("file:///player.gd", source);
		symbols.update("file:///player.gd");
		references.update("file:///player.gd");

		const player = symbols.find("Player")[0];
		assert.equal(references.findForSymbol(player, true).length, 1);

		files.update("file:///player.gd", "class_name Enemy\nvar health: int\nhealth = 1\n");
		symbols.update("file:///player.gd");
		references.update("file:///player.gd");
		assert.equal(references.find("Player").length, 0);
		assert.equal(references.find("health").length, 2);
	});
});
