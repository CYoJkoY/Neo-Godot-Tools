import { strict as assert } from "node:assert";
import { describe, it } from "node:test";
import type { GDScriptScript } from "../analyzer/index.js";
import type { DependencyEdge } from "./dependency_graph.js";
import type { IndexedFile } from "./symbol.js";
import { classifySemanticChange } from "./semantic_change.js";
import { createSourceFingerprint } from "./semantic_snapshot.js";

function file(source: string, apiFingerprint: string): IndexedFile {
	return {
		uri: "file:///project/test.gd",
		version: 1,
		source,
		sourceFingerprint: createSourceFingerprint(source),
		ast: {} as GDScriptScript,
		diagnostics: [],
		symbols: [],
		apiFingerprint,
	};
}

const dependency: DependencyEdge = {
	from: "file:///project/test.gd",
	to: "file:///project/base.gd",
	reason: "extends",
};

describe("classifySemanticChange", () => {
	it("classifies body-only edits without invalidating dependents", () => {
		assert.deepEqual(classifySemanticChange(file("func run():\n\treturn 1", "api"), file("func run():\n\treturn 2", "api")), { kind: "body_changed" });
	});

	it("classifies public API changes before body changes", () => {
		assert.deepEqual(classifySemanticChange(file("func run():\n\treturn 1", "api-a"), file("func run(value: int):\n\treturn value", "api-b")), { kind: "api_changed" });
	});

	it("classifies dependency changes independently from API changes", () => {
		assert.deepEqual(classifySemanticChange(file("extends Base", "api"), file("extends Other", "api"), [dependency], []), { kind: "dependency_changed" });
	});

	it("classifies additions and removals", () => {
		assert.deepEqual(classifySemanticChange(undefined, file("extends Base", "api")), { kind: "file_added" });
		assert.deepEqual(classifySemanticChange(file("extends Base", "api"), undefined), { kind: "file_removed" });
	});

	it("ignores dependency ordering", () => {
		const other: DependencyEdge = { ...dependency, to: "file:///project/other.gd", reason: "preload" };
		assert.deepEqual(classifySemanticChange(file("source", "api"), file("source", "api"), [dependency, other], [other, dependency]), { kind: "unchanged" });
	});

	it("classifies unchanged snapshots without invalidation", () => {
		assert.deepEqual(classifySemanticChange(file("source", "api"), file("source", "api")), { kind: "unchanged" });
	});
});
