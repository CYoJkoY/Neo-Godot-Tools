import { strict as assert } from "node:assert";
import { BindingIndex, DependencyGraph, FileIndex, SymbolIndex, TypeResolutionIndex } from "./index.js";

const files = new FileIndex();
const symbols = new SymbolIndex(files);
const bindings = new BindingIndex(files);
const types = new TypeResolutionIndex(files, symbols, bindings);
const dependencies = new DependencyGraph(files);

files.update("file:///workspace/player.gd", `class_name Player\nvar health: int\nfunc take_damage(amount: int) -> void:\n\thealth -= amount\n`);
symbols.update("file:///workspace/player.gd");
bindings.update("file:///workspace/player.gd");

autoTest();

function autoTest(): void {
	const playerType = types.resolveName("Player");
	assert.equal(playerType?.uri, "file:///workspace/player.gd");
	assert.equal(types.getMember(playerType!, "health")?.name, "health");

	files.update("file:///workspace/main.gd", `extends Node\nvar player: Player\nfunc test():\n\tplayer.health = 10\n`);
	symbols.update("file:///workspace/main.gd");
	bindings.update("file:///workspace/main.gd");
	dependencies.update("file:///workspace/main.gd");
	const receiver = types.resolveReceiver("file:///workspace/main.gd", 72, "player");
	assert.equal(receiver?.name, "Player");
	assert.equal(types.getMember(receiver!, "health")?.name, "health");

	files.update("file:///workspace/other.gd", `var player = preload(\"res://player.gd\")\n`);
	symbols.update("file:///workspace/other.gd");
	dependencies.update("file:///workspace/other.gd");
	assert.equal(dependencies.getDependencies("file:///workspace/other.gd").length, 1);
	assert.equal(dependencies.getDependencies("file:///workspace/other.gd")[0].reason, "preload");
	assert.equal(dependencies.getDependents("file:///workspace/player.gd").length, 1);
}
