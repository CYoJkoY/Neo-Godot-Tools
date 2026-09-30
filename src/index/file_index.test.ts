import { strict as assert } from "node:assert";
import { describe, it } from "node:test";
import { FileIndex } from "./file_index.js";

describe("FileIndex", () => {
	it("reuses the semantic snapshot when only the document version changes", () => {
		const index = new FileIndex();
		const first = index.update("file:///project/test.gd", "", 1);
		const second = index.update("file:///project/test.gd", "", 2);

		assert.equal(second, first);
		assert.equal(second.version, 2);
	});

	it("rebuilds the semantic snapshot when source changes", () => {
		const index = new FileIndex();
		const first = index.update("file:///project/test.gd", "var value = 1", 1);
		const second = index.update("file:///project/test.gd", "var value = 2", 2);

		assert.notEqual(second, first);
		assert.equal(second.source, "var value = 2");
	});
});
