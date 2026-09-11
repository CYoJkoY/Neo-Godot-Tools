import { describe, expect, it } from "vitest";
import { FileIndex } from "./file_index";
import { ReferenceIndex, collectReferences } from "./references";
import { SymbolIndex } from "./symbol_index";

const source = `class_name Player
var health: int
func heal(amount: int) -> void:
\thealth += amount
\thealth = clamp(health, 0, 100)
`;

describe("reference index", () => {
	it("collects code identifiers but not comments or strings", () => {
		const references = collectReferences(`${source}\n# health health\nvar label = "health"\n`, "file:///player.gd");
		expect(references.filter((reference) => reference.name === "health")).toHaveLength(4);
		expect(references.some((reference) => reference.name === "amount")).toBe(true);
		expect(references.some((reference) => reference.name === "class_name")).toBe(false);
	});

	it("replaces references incrementally with the file", () => {
		const files = new FileIndex();
		const symbols = new SymbolIndex(files);
		const references = new ReferenceIndex(files);
		files.update("file:///player.gd", source);
		symbols.update("file:///player.gd");
		references.update("file:///player.gd");

		const player = symbols.find("Player")[0];
		expect(references.findForSymbol(player, true)).toHaveLength(1);

		files.update("file:///player.gd", "class_name Enemy\nvar health: int\nhealth = 1\n");
		symbols.update("file:///player.gd");
		references.update("file:///player.gd");
		expect(references.find("Player")).toHaveLength(0);
		expect(references.find("health")).toHaveLength(2);
	});
});
