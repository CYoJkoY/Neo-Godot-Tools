import { describe, expect, it } from "vitest";
import { FileIndex } from "./file_index.js";

describe("FileIndex", () => {
	it("reuses the semantic snapshot when only the document version changes", () => {
		const index = new FileIndex();
		const first = index.update("file:///project/test.gd", "", 1);
		const second = index.update("file:///project/test.gd", "", 2);

		expect(second).toBe(first);
		expect(second.version).toBe(2);
	});

	it("rebuilds the semantic snapshot when source changes", () => {
		const index = new FileIndex();
		const first = index.update("file:///project/test.gd", "var value = 1", 1);
		const second = index.update("file:///project/test.gd", "var value = 2", 2);

		expect(second).not.toBe(first);
		expect(second.source).toBe("var value = 2");
	});
});
