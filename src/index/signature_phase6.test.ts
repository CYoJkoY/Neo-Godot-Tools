import { describe, expect, it } from "vitest";
import { FileIndex } from "./file_index";
import { SymbolIndex } from "./symbol_index";

describe("indexed signatures", () => {
	it("preserves function parameter metadata", () => {
		const files = new FileIndex();
		const symbols = new SymbolIndex(files);
		files.update("file:///player.gd", "func heal(amount: int, factor: float = 1.0) -> int:\n\treturn int(amount * factor)\n");
		symbols.update("file:///player.gd");
		const healFunction = symbols.find("heal")[0];
		expect(healFunction.parameters).toEqual([
			{ name: "amount", type: "int", defaultValue: undefined },
			{ name: "factor", type: "float", defaultValue: "1.0" },
		]);
		expect(healFunction.returnType).toBe("int");
	});
});
