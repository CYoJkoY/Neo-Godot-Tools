import { strict as assert } from "node:assert";
import { BindingIndex, DependencyGraph, FileIndex, SymbolIndex, TypeResolutionIndex } from "./index.js";

const files = new FileIndex();
const symbols = new SymbolIndex(files);
const bindings = new BindingIndex(files);
const types = new TypeResolutionIndex(files, symbols, bindings);
const dependencies = new DependencyGraph(files);

const baseUri = "file:///workspace/base.gd";
const playerUri = "file:///workspace/player.gd";
const mainUri = "file:///workspace/main.gd";

const baseSource = `class_name Base\nvar base_health: int\nfunc heal() -> void:\n\tbase_health += 1\n`;
files.update(baseUri, baseSource);
symbols.update(baseUri);
bindings.update(baseUri);

const playerSource = `class_name Player\nextends Base\nvar health: int\nfunc take_damage(amount: int) -> void:\n\thealth -= amount\n`;
files.update(playerUri, playerSource);
symbols.update(playerUri);
bindings.update(playerUri);
dependencies.update(playerUri);

const playerType = types.resolveName("Player");
assert.equal(playerType?.uri, playerUri);
assert.equal(types.getMember(playerType!, "health")?.name, "health");
assert.equal(types.getMember(playerType!, "heal")?.name, "heal");
assert.equal(dependencies.getDependencies(playerUri).length, 1);

const mainSource = `extends Node\nvar player: Player\nvar spawned = preload("res://player.gd").new()\nfunc make_player() -> Player:\n\treturn Player.new()\nvar returned = make_player()\nfunc test():\n\tplayer.health = 10\n\tspawned.take_damage(1)\n\treturned.heal()\n`;
files.update(mainUri, mainSource);
symbols.update(mainUri);
bindings.update(mainUri);
dependencies.update(mainUri);

const playerOffset = mainSource.indexOf("player.health");
const spawnedOffset = mainSource.indexOf("spawned.take_damage");
const returnedOffset = mainSource.indexOf("returned.heal");

assert.equal(types.resolveReceiver(mainUri, playerOffset, "player")?.name, "Player");
assert.equal(types.resolveReceiver(mainUri, spawnedOffset, "spawned")?.name, "Player");
assert.equal(types.resolveReceiver(mainUri, returnedOffset, "returned")?.name, "Player");
assert.equal(types.getMember(types.resolveReceiver(mainUri, spawnedOffset, "spawned")!, "take_damage")?.name, "take_damage");
assert.equal(types.getMember(types.resolveReceiver(mainUri, returnedOffset, "returned")!, "returned")?.name, undefined);
assert.equal(types.getMember(types.resolveReceiver(mainUri, returnedOffset, "returned")!, "heal")?.name, "heal");

assert.equal(dependencies.getDependencies(mainUri).length, 1);
assert.deepEqual(dependencies.getTransitiveDependents(baseUri), [playerUri, mainUri]);
