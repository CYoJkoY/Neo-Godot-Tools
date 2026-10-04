import { strict as assert } from "node:assert";
import { performance } from "node:perf_hooks";
import { describe, it } from "node:test";
import { createBindingIndex } from "./bindings.js";
import { createDependencyGraph } from "./dependency_graph.js";
import { createFileIndex } from "./file_index.js";
import { createReferenceIndex } from "./references.js";
import { createSymbolIndex } from "./symbol_index.js";
import { createTypeResolutionIndex } from "./type_resolution.js";

/**
 * Synthetic file with many distinct identifiers. Real Godot projects have
 * thousands of scripts whose names do not repeat, which is what exposed the
 * quadratic removals in the binding/reference indexes.
 */
function sourceFor(index: number): string {
	let source = `class_name Synthetic${index}\nextends Node\n\nvar value_${index}: int = ${index}\nvar other_${index} := Vector2(1, 2)\n\nfunc get_value_${index}() -> int:\n\tvar local_${index} := value_${index}\n\treturn local_${index}\n\nfunc use_${index}(amount_${index}: int) -> void:\n\tfor step_${index} in range(amount_${index}):\n\t\tvalue_${index} += step_${index}\n\tprint(other_${index}, get_value_${index}())\n`;
	for (let helper = 0; helper < 8; helper++) {
		source += `\nfunc helper_${index}_${helper}(argument_${index}_${helper}: int) -> int:\n\treturn argument_${index}_${helper} + value_${index}\n`;
	}
	return source;
}

function indexProject(count: number): number {
	const files = createFileIndex();
	const symbols = createSymbolIndex(files);
	const bindings = createBindingIndex(files);
	const references = createReferenceIndex(files);
	const dependencies = createDependencyGraph(files);
	const start = performance.now();
	for (let index = 0; index < count; index++) {
		const uri = `file:///workspace/scripts_${index}.gd`;
		files.update(uri, sourceFor(index), 1);
		dependencies.update(uri);
		symbols.update(uri);
		references.update(uri);
		bindings.update(uri);
	}
	return performance.now() - start;
}

describe("project index scaling", () => {
	it("indexes a larger project without quadratic slowdown", () => {
		const small = indexProject(400);
		const large = indexProject(800);
		// Linear indexing doubles the time; the previous quadratic removals made
		// it grow ~4x. Keep generous headroom for CI noise while still failing on
		// a return to quadratic behaviour.
		assert.ok(
			large < small * 3.5 + 250,
			`indexing 800 files took ${large.toFixed(0)}ms versus ${small.toFixed(0)}ms for 400 files`,
		);
		assert.ok(large < 20_000, `indexing 800 files took ${large.toFixed(0)}ms`);
	});

	it("keeps a single document edit independent of project size", () => {
		const files = createFileIndex();
		const symbols = createSymbolIndex(files);
		const bindings = createBindingIndex(files);
		const references = createReferenceIndex(files);
		const dependencies = createDependencyGraph(files);
		for (let index = 0; index < 600; index++) {
			const uri = `file:///workspace/scripts_${index}.gd`;
			files.update(uri, sourceFor(index), 1);
			dependencies.update(uri);
			symbols.update(uri);
			references.update(uri);
			bindings.update(uri);
		}
		const target = "file:///workspace/scripts_599.gd";
		const edited = `${sourceFor(599)}\n# edited\n`;
		const start = performance.now();
		files.update(target, edited, 2);
		dependencies.update(target);
		symbols.update(target);
		references.update(target);
		bindings.update(target);
		const elapsed = performance.now() - start;
		assert.ok(elapsed < 500, `single edit took ${elapsed.toFixed(1)}ms with 600 indexed files`);
	});
});

describe("script path lookup", () => {
	it("resolves unique res:// suffixes and rejects ambiguous basenames", () => {
		const files = createFileIndex();
		files.update("file:///project/scripts/player.gd", "extends Node\n");
		files.update("file:///project/scenes/enemy.gd", "extends Node\n");
		assert.equal(files.findByPathSuffix("res://scripts/player.gd"), "file:///project/scripts/player.gd");
		assert.equal(files.findByPathSuffix("scripts/player.gd"), "file:///project/scripts/player.gd");
		assert.equal(files.findByPathSuffix("res://missing.gd"), undefined);

		files.update("file:///project/other/player.gd", "extends Node\n");
		assert.equal(files.findByPathSuffix("player.gd"), undefined, "ambiguous basenames must not resolve");
		assert.equal(files.findByPathSuffix("res://other/player.gd"), "file:///project/other/player.gd");

		files.remove("file:///project/other/player.gd");
		assert.equal(files.findByPathSuffix("player.gd"), "file:///project/scripts/player.gd");
	});

	it("resolves extends against files that were never updated in the graph", () => {
		const files = createFileIndex();
		const symbols = createSymbolIndex(files);
		const bindings = createBindingIndex(files);
		const types = createTypeResolutionIndex(files, symbols, bindings);
		const dependencies = createDependencyGraph(files);

		files.update("file:///project/base.gd", "class_name Base\nfunc heal() -> void:\n\tpass\n");
		symbols.update("file:///project/base.gd");
		files.update("file:///project/player.gd", "class_name Player\nextends Base\n");
		symbols.update("file:///project/player.gd");
		dependencies.update("file:///project/player.gd");

		assert.equal(dependencies.getDependencies("file:///project/player.gd").length, 1);
		assert.equal(types.resolveName("Player")?.symbol?.name, "Player");
	});

	it("resolves a preload path that only the file index knows about", () => {
		const files = createFileIndex();
		const dependencies = createDependencyGraph(files);
		files.update("file:///project/scripts/tool.gd", "extends Node\n");
		files.update("file:///project/main.gd", 'extends Node\nvar tool = preload("res://scripts/tool.gd").new()\n');
		dependencies.update("file:///project/main.gd");
		assert.equal(dependencies.getDependencies("file:///project/main.gd")[0]?.to, "file:///project/scripts/tool.gd");
	});
});
