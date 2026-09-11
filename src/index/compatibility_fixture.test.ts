import { strict as assert } from "node:assert";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { BindingIndex, FileIndex, SymbolIndex, TypeResolutionIndex } from "./index.js";

const FIXTURE_ROOT = join(process.cwd(), "test_fixtures", "semantic");

function loadFixture(name: string): string {
	return readFileSync(join(FIXTURE_ROOT, name), "utf8");
}

function indexFixture(name: string, uri: string) {
	const files = new FileIndex();
	const symbols = new SymbolIndex(files);
	const bindings = new BindingIndex(files);
	const types = new TypeResolutionIndex(files, symbols, bindings);
	const source = loadFixture(name);
	const file = files.update(uri, source, 1);
	symbols.update(uri);
	bindings.update(uri);
	return { source, file, symbols, types, uri };
}

for (const fixture of [
	["godot3_legacy.gd", "file:///fixtures/godot3_legacy.gd", "LegacyActor"],
	["godot4_modern.gd", "file:///fixtures/godot4_modern.gd", "ModernActor"],
] as const) {
	test(`semantic fixture indexes ${fixture[0]}`, () => {
		const result = indexFixture(fixture[0], fixture[1]);
		assert.equal(result.file.diagnostics.length, 0, "fixture must parse without diagnostics");
		assert.ok(result.file.symbols.some((symbol) => symbol.name === fixture[2]), "class_name must be indexed");
		assert.ok(result.file.symbols.some((symbol) => symbol.name === "get_health"), "function must be indexed");
		assert.ok(result.file.symbols.some((symbol) => symbol.name === "base_health"), "portable typed member must be indexed");
	});
}

test("Godot 3 fixture preserves inferred constructor semantics", () => {
	const result = indexFixture("godot3_legacy.gd", "file:///fixtures/godot3_legacy.gd");
	const offset = result.source.indexOf("child :=") + "child".length;
	assert.equal(result.types.resolveReceiver(result.uri, offset, "child")?.name, "LegacyActor");
});

test("Godot 4 fixture preserves typed member and inferred constructor semantics", () => {
	const result = indexFixture("godot4_modern.gd", "file:///fixtures/godot4_modern.gd");
	const healthOffset = result.source.indexOf("base_health: int") + 1;
	const childOffset = result.source.indexOf("child :=") + "child".length;
	assert.equal(result.types.resolveReceiver(result.uri, healthOffset, "base_health")?.name, "int");
	assert.equal(result.types.resolveReceiver(result.uri, childOffset, "child")?.name, "ModernActor");
});
