import { strict as assert } from "node:assert";
import { test } from "node:test";
import { FileIndex, SymbolIndex } from "./index.js";

test("FileIndex stores parsed files and rebuilds symbols", () => {
	const files = new FileIndex();
	const uri = "file:///workspace/player.gd";
	const file = files.update(uri, `class_name Player\nvar health: int = 100\nfunc move() -> void:\n\tpass\n`, 7);

	assert.equal(files.size, 1);
	assert.equal(file.version, 7);
	assert.deepEqual(file.symbols.map((symbol) => symbol.name), ["Player", "health", "move"]);
	assert.equal(files.get(uri)?.ast.declarations.length, 3);

	files.update(uri, `class_name Player\nfunc reset() -> void:\n\tpass\n`, 8);
	assert.deepEqual(files.get(uri)?.symbols.map((symbol) => symbol.name), ["Player", "reset"]);
});

test("SymbolIndex supports incremental updates and workspace queries", () => {
	const files = new FileIndex();
	const symbols = new SymbolIndex(files);
	const player = "file:///workspace/player.gd";
	const enemy = "file:///workspace/enemy.gd";

	files.update(player, `class_name Player\nfunc move() -> void:\n\tpass\n`);
	symbols.update(player);
	files.update(enemy, `class_name Enemy\nfunc move() -> void:\n\tpass\n`);
	symbols.update(enemy);

	assert.equal(symbols.find("Player").length, 1);
	assert.equal(symbols.find("move").length, 2);
	assert.equal(symbols.findInFile(enemy, "Enemy")?.kind, "class_name");
	assert.deepEqual(symbols.workspaceSymbols("play").map((symbol) => symbol.name), ["Player"]);

	files.update(enemy, `class_name Boss\nfunc attack() -> void:\n\tpass\n`);
	symbols.update(enemy);
	assert.equal(symbols.find("Enemy").length, 0);
	assert.equal(symbols.find("Boss").length, 1);
	assert.equal(symbols.find("attack").length, 1);

	files.remove(player);
	symbols.remove(player);
	assert.equal(symbols.find("Player").length, 0);
});
