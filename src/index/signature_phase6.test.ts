import { strict as assert } from "node:assert";
import { describe, it } from "node:test";
import { FileIndex } from "./file_index";
import { SymbolIndex } from "./symbol_index";

describe("indexed signatures", () => {
	it("preserves function parameter metadata", () => {
		const files = new FileIndex();
		const symbols = new SymbolIndex(files);
		files.update("file:///player.gd", "func heal(amount: int, factor: float = 1.0) -> int:\n\treturn int(amount * factor)\n");
		symbols.update("file:///player.gd");
		const healFunction = symbols.find("heal")[0];
		assert.deepEqual(healFunction.parameters, [
			{ name: "amount", type: "int", defaultValue: undefined },
			{ name: "factor", type: "float", defaultValue: "1.0" },
		]);
		assert.equal(healFunction.returnType, "int");
	});
});
