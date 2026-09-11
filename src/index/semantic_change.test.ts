import { describe, expect, it } from "vitest";
import type { GDScriptScript } from "../analyzer/index.js";
import type { DependencyEdge } from "./dependency_graph.js";
import type { IndexedFile } from "./symbol.js";
import { classifySemanticChange } from "./semantic_change.js";

function file(source: string, apiFingerprint: string): IndexedFile {
	return {
		uri: "file:///project/test.gd",
		version: 1,
		source,
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
		expect(classifySemanticChange(file("func run():\n\treturn 1", "api"), file("func run():\n\treturn 2", "api"))).toEqual({ kind: "body_changed" });
	});

	it("classifies public API changes before body changes", () => {
		expect(classifySemanticChange(file("func run():\n\treturn 1", "api-a"), file("func run(value: int):\n\treturn value", "api-b"))).toEqual({ kind: "api_changed" });
	});

	it("classifies dependency changes independently from API changes", () => {
		expect(classifySemanticChange(file("extends Base", "api"), file("extends Other", "api"), [dependency], [])).toEqual({ kind: "dependency_changed" });
	});

	it("classifies additions and removals", () => {
		expect(classifySemanticChange(undefined, file("extends Base", "api"))).toEqual({ kind: "file_added" });
		expect(classifySemanticChange(file("extends Base", "api"), undefined)).toEqual({ kind: "file_removed" });
	});

	it("ignores dependency ordering", () => {
		const other: DependencyEdge = { ...dependency, to: "file:///project/other.gd", reason: "preload" };
		expect(classifySemanticChange(file("source", "api"), file("source", "api"), [dependency, other], [other, dependency])).toEqual({ kind: "unchanged" });
	});

	it("classifies unchanged snapshots without invalidation", () => {
		expect(classifySemanticChange(file("source", "api"), file("source", "api"))).toEqual({ kind: "unchanged" });
	});
});
