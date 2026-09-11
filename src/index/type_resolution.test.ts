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
files.update(baseUri, baseSource, 1);
symbols.update(baseUri);
bindings.update(baseUri);

const playerSource = `class_name Player\nextends Base\nvar health: int\nfunc take_damage(amount: int) -> void:\n\thealth -= amount\nfunc make_resource():\n\treturn Resource.new()\n`;
files.update(playerUri, playerSource, 1);
symbols.update(playerUri);
bindings.update(playerUri);
dependencies.update(playerUri);

const playerType = types.resolveName("Player");
assert.equal(playerType?.uri, playerUri);
assert.equal(types.getMember(playerType!, "health")?.name, "health");
assert.equal(types.getMember(playerType!, "heal")?.name, "heal");
assert.equal(dependencies.getDependencies(playerUri).length, 1);

const mainSource = `extends Node\nvar player: Player\nvar spawned = preload("res://player.gd").new()\nfunc make_player():\n\tvar local_player = Player.new()\n\tlocal_player = Player.new()\n\treturn local_player\nfunc test():\n\tvar assigned\n\tassigned = Player.new()\n\tplayer.health = 10\n\tspawned.take_damage(1)\n\tvar returned = make_player()\n\treturned.heal()\n\tassigned.heal()\n`;
files.update(mainUri, mainSource, 1);
symbols.update(mainUri);
bindings.update(mainUri);
dependencies.update(mainUri);

const playerOffset = mainSource.indexOf("player.health");
const spawnedOffset = mainSource.indexOf("spawned.take_damage");
const returnedOffset = mainSource.indexOf("returned.heal");
const assignedOffset = mainSource.indexOf("assigned.heal");
const localPlayerOffset = mainSource.indexOf("local_player = Player.new()");

assert.equal(types.resolveReceiver(mainUri, playerOffset, "player")?.name, "Player");
assert.equal(types.resolveReceiver(mainUri, spawnedOffset, "spawned")?.name, "Player");
assert.equal(types.resolveReceiver(mainUri, returnedOffset, "returned")?.name, "Player");
assert.equal(types.resolveReceiver(mainUri, assignedOffset, "assigned")?.name, "Player");
assert.equal(types.resolveReceiver(mainUri, localPlayerOffset, "local_player")?.name, "Player");
assert.equal(types.getMember(types.resolveReceiver(mainUri, spawnedOffset, "spawned")!, "take_damage")?.name, "take_damage");
assert.equal(types.getMember(types.resolveReceiver(mainUri, returnedOffset, "returned")!, "returned")?.name, undefined);
assert.equal(types.getMember(types.resolveReceiver(mainUri, returnedOffset, "returned")!, "heal")?.name, "heal");

const resourceReturn = types.resolveMemberReturnType(playerType!, types.getMember(playerType!, "make_resource")!);
assert.equal(resourceReturn?.name, "Resource");

assert.equal(dependencies.getDependencies(mainUri).length, 1);
assert.deepEqual(dependencies.getTransitiveDependents(baseUri), [playerUri, mainUri]);

const cachedPlayerMembers = types.getMembers(playerType!);
assert.equal(cachedPlayerMembers.some((symbol) => symbol.name === "base_health"), true);
const changedBaseSource = `class_name Base\nvar shield: int\nfunc heal() -> void:\n\tshield += 1\n`;
files.update(baseUri, changedBaseSource, 2);
symbols.update(baseUri);
bindings.update(baseUri);
types.invalidate([baseUri, ...dependencies.getTransitiveDependents(baseUri)]);
const refreshedPlayerType = types.resolveName("Player");
const refreshedPlayerMembers = types.getMembers(refreshedPlayerType!);
assert.equal(refreshedPlayerMembers.some((symbol) => symbol.name === "base_health"), false);
assert.equal(refreshedPlayerMembers.some((symbol) => symbol.name === "shield"), true);
assert.notEqual(refreshedPlayerMembers, cachedPlayerMembers);
