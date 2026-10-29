import { strict as assert } from "node:assert";
import { test } from "node:test";
import { createFileIndex, createSymbolIndex } from "./index.js";

test("FileIndex stores parsed files and rebuilds symbols", () => {
	const files = createFileIndex();
	const uri = "file:///workspace/player.gd";
	const file = files.update(uri, `class_name Player\nvar health: int = 100\nfunc move() -> void:\n\tpass\n`, 7);

	assert.equal(files.size, 1);
	assert.equal(file.version, 7);
	assert.deepEqual(
		file.symbols.map((symbol) => symbol.name),
		["Player", "health", "move"],
	);
	assert.equal(files.get(uri)?.ast.declarations.length, 3);

	files.update(uri, `class_name Player\nfunc reset() -> void:\n\tpass\n`, 8);
	assert.deepEqual(
		files.get(uri)?.symbols.map((symbol) => symbol.name),
		["Player", "reset"],
	);
});

test("SymbolIndex supports incremental updates and workspace queries", () => {
	const files = createFileIndex();
	const symbols = createSymbolIndex(files);
	const player = "file:///workspace/player.gd";
	const enemy = "file:///workspace/enemy.gd";

	files.update(player, `class_name Player\nfunc move() -> void:\n\tpass\n`);
	symbols.update(player);
	files.update(enemy, `class_name Enemy\nfunc move() -> void:\n\tpass\n`);
	symbols.update(enemy);

	assert.equal(symbols.find("Player").length, 1);
	assert.equal(symbols.find("move").length, 2);
	assert.equal(symbols.findInFile(enemy, "Enemy")?.kind, "class_name");
	assert.deepEqual(
		symbols.workspaceSymbols("play").map((symbol) => symbol.name),
		["Player"],
	);

	files.update(enemy, `class_name Boss\nfunc attack() -> void:\n\tpass\n`);
	symbols.update(enemy);
	assert.equal(symbols.find("Enemy").length, 0);
	assert.equal(symbols.find("Boss").length, 1);
	assert.equal(symbols.find("attack").length, 1);

	files.remove(player);
	symbols.remove(player);
	assert.equal(symbols.find("Player").length, 0);
});

test("SymbolIndex keeps the captured symbols of each file", () => {
	const files = createFileIndex();
	const symbols = createSymbolIndex(files);
	const uri = "file:///workspace/shift.gd";
	const source = "extends Node\n\nfunc first() -> void:\n\tpass\n\nfunc second() -> void:\n\tpass\n";

	files.update(uri, source, 1);
	symbols.update(uri);
	const captured = symbols.fileSymbols(uri);
	assert.deepEqual(symbols.fileUris(), [uri]);
	assert.deepEqual(captured.map((symbol) => symbol.name), ["first", "second"]);
	const secondOffset = captured.find((symbol) => symbol.name === "second")?.range.start.offset;

	// A body edit reparses the file but leaves the capture until the next update,
	// which is the range every workspace query answers with.
	files.update(uri, `extends Node\n\nfunc first() -> void:\n\tpass\n\tpass\n\tpass\n\nfunc second() -> void:\n\tpass\n`, 2);
	assert.deepEqual(symbols.fileSymbols(uri), captured);
	assert.equal(symbols.workspaceSymbols("second").at(0)?.range.start.offset, secondOffset);

	assert.deepEqual(createSymbolIndex(files).fileSymbols(uri), []);
});
