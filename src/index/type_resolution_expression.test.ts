import { strict as assert } from "node:assert";
import { test } from "node:test";
import { BindingIndex, FileIndex, SymbolIndex, TypeResolutionIndex } from "./index.js";

test("resolves inferred declarations and typed member access through local semantics", () => {
	const files = new FileIndex();
	const symbols = new SymbolIndex(files);
	const bindings = new BindingIndex(files);
	const types = new TypeResolutionIndex(files, symbols, bindings);

	const playerUri = "file:///workspace/player.gd";
	const mainUri = "file:///workspace/main.gd";
	const playerSource = `class_name Player\nvar health: int = 100\nfunc get_health() -> int:\n\treturn health\n`;
	const mainSource = `extends Node\nvar player: Player\nfunc test():\n\tvar local_player := Player.new()\n\tvar local_health := local_player.health\n\tvar returned := local_player.get_health()\n\treturn local_health\n`;

	files.update(playerUri, playerSource, 1);
	symbols.update(playerUri);
	bindings.update(playerUri);
	files.update(mainUri, mainSource, 1);
	symbols.update(mainUri);
	bindings.update(mainUri);

	const localPlayerOffset = mainSource.indexOf("local_player.health");
	const localHealthOffset = mainSource.indexOf("local_health\n");
	const returnedOffset = mainSource.indexOf("returned :=") + 12;

	assert.equal(types.resolveReceiver(mainUri, localPlayerOffset, "local_player")?.name, "Player");
	assert.equal(types.resolveReceiver(mainUri, localHealthOffset, "local_health")?.name, "int");
	assert.equal(types.resolveReceiver(mainUri, returnedOffset, "returned")?.name, "int");
});

test("keeps ambiguous chained member expressions unresolved", () => {
	const files = new FileIndex();
	const symbols = new SymbolIndex(files);
	const bindings = new BindingIndex(files);
	const types = new TypeResolutionIndex(files, symbols, bindings);

	const source = `class_name Holder\nvar child: MissingType\nfunc test():\n\tvar holder: Holder\n\tvar value := holder.child.name\n`;
	const uri = "file:///workspace/holder.gd";
	files.update(uri, source, 1);
	symbols.update(uri);
	bindings.update(uri);

	const offset = source.indexOf("holder.child.name");
	assert.equal(types.resolveReceiver(uri, offset, "value"), undefined);
});
