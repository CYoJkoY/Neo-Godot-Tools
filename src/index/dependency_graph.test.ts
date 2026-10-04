import { strict as assert } from "node:assert";
import { describe, it } from "node:test";
import { createDependencyGraph } from "./dependency_graph.js";
import { createFileIndex } from "./file_index.js";

describe("DependencyGraph", () => {
	it("refreshes unresolved dependencies when a target file is added", () => {
		const files = createFileIndex();
		const graph = createDependencyGraph(files);
		const sourceUri = "file:///project/source.gd";
		const targetUri = "file:///project/base.gd";

		files.update(sourceUri, 'const Base = preload("res://base.gd")');
		graph.update(sourceUri);
		assert.deepEqual(graph.getDependencies(sourceUri), []);

		files.update(targetUri, "class_name Base");
		assert.deepEqual(graph.update(targetUri), [sourceUri]);
		assert.deepEqual(graph.getDependencies(sourceUri), [{ from: sourceUri, to: targetUri, reason: "preload" }]);
	});

	it("refreshes dependents after a target file is removed", () => {
		const files = createFileIndex();
		const graph = createDependencyGraph(files);
		const sourceUri = "file:///project/source.gd";
		const targetUri = "file:///project/base.gd";

		files.update(targetUri, "class_name Base");
		files.update(sourceUri, 'const Base = preload("res://base.gd")');
		graph.update(targetUri);
		graph.update(sourceUri);
		assert.deepEqual(graph.getDependents(targetUri), [sourceUri]);

		const dependents = graph.remove(targetUri);
		files.remove(targetUri);
		for (const dependent of dependents) graph.update(dependent);

		assert.deepEqual(graph.getDependencies(sourceUri), []);
	});
});
