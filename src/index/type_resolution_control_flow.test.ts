import assert from "node:assert/strict";
import { BindingIndex, FileIndex, SymbolIndex, TypeResolutionIndex } from "./index.js";

const files = new FileIndex();
const symbols = new SymbolIndex(files);
const bindings = new BindingIndex(files);
const types = new TypeResolutionIndex(files, symbols, bindings);

const playerUri = "file:///workspace/player.gd";
files.update(playerUri, `class_name Player\nextends Node\n`, 1);
symbols.update(playerUri);
bindings.update(playerUri);

const mainUri = "file:///workspace/main.gd";
const source = `extends Node\nfunc resolve(flag: bool):\n\tvar value\n\tif flag:\n\t\tvalue = Player.new()\n\telse:\n\t\tvalue = Player.new()\n\tvalue\n`;
files.update(mainUri, source, 1);
symbols.update(mainUri);
bindings.update(mainUri);

const valueOffset = source.lastIndexOf("\tvalue") + 2;
assert.equal(types.resolveReceiver(mainUri, valueOffset, "value")?.name, "Player");

const uncertain = `extends Node\nfunc resolve(flag: bool):\n\tvar value = Resource.new()\n\tif flag:\n\t\tvalue = Player.new()\n\tvalue\n`;
files.update(mainUri, uncertain, 2);
symbols.update(mainUri);
bindings.update(mainUri);
types.invalidate([mainUri]);
const uncertainOffset = uncertain.lastIndexOf("\tvalue") + 2;
assert.equal(types.resolveReceiver(mainUri, uncertainOffset, "value"), undefined);

console.log("type-resolution control-flow integration passed");
