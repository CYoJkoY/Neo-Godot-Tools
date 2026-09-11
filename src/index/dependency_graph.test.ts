import { describe, expect, it } from "vitest";
import { DependencyGraph } from "./dependency_graph.js";
import { FileIndex } from "./file_index.js";

describe("DependencyGraph", () => {
	it("refreshes unresolved dependencies when a target file is added", () => {
		const files = new FileIndex();
		const graph = new DependencyGraph(files);
		const sourceUri = "file:///project/source.gd";
		const targetUri = "file:///project/base.gd";

		files.update(sourceUri, 'const Base = preload("res://base.gd")');
		graph.update(sourceUri);
		expect(graph.getDependencies(sourceUri)).toEqual([]);

		files.update(targetUri, "class_name Base");
		expect(graph.update(targetUri)).toEqual([sourceUri]);
		expect(graph.getDependencies(sourceUri)).toEqual([
			{ from: sourceUri, to: targetUri, reason: "preload" },
		]);
	});

	it("refreshes dependents after a target file is removed", () => {
		const files = new FileIndex();
		const graph = new DependencyGraph(files);
		const sourceUri = "file:///project/source.gd";
		const targetUri = "file:///project/base.gd";

		files.update(targetUri, "class_name Base");
		files.update(sourceUri, 'const Base = preload("res://base.gd")');
		graph.update(targetUri);
		graph.update(sourceUri);
		expect(graph.getDependents(targetUri)).toEqual([sourceUri]);

		const dependents = graph.remove(targetUri);
		files.remove(targetUri);
		for (const dependent of dependents) graph.update(dependent);

		expect(graph.getDependencies(sourceUri)).toEqual([]);
	});
});
