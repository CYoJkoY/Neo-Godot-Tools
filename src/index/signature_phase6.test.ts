import { strict as assert } from "node:assert";
import { describe, it } from "node:test";
import { createFileIndex } from "./file_index";
import { createSymbolIndex } from "./symbol_index";

describe("indexed signatures", () => {
	it("preserves function parameter metadata", () => {
		const files = createFileIndex();
		const symbols = createSymbolIndex(files);
		files.update(
			"file:///player.gd",
			"func heal(amount: int, factor: float = 1.0) -> int:\n\treturn int(amount * factor)\n",
		);
		symbols.update("file:///player.gd");
		const healFunction = symbols.find("heal")[0];
		assert.deepEqual(healFunction.parameters, [
			{ name: "amount", type: "int", defaultValue: undefined },
			{ name: "factor", type: "float", defaultValue: "1.0" },
		]);
		assert.equal(healFunction.returnType, "int");
	});
});
