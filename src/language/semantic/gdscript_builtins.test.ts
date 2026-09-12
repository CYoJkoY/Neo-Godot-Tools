import assert from "node:assert/strict";
import test from "node:test";
import { getGDScriptBuiltin, getGDScriptBuiltins, getGDScriptBuiltinDocumentationClass, builtinToSymbol } from "./gdscript_builtins.js";

test("GDScript builtin catalog exposes common global functions", () => {
	const names = ["print", "load", "preload", "clamp", "lerp", "typeof", "str", "randf", "push_error"];
	for (const name of names) {
		const builtin = getGDScriptBuiltin(name);
		assert.ok(builtin, `missing builtin ${name}`);
		assert.equal(builtin.name, name);
	}
});

test("GDScript-only builtins resolve to the @GDScript documentation class", () => {
	const builtin = getGDScriptBuiltin("range");
	assert.ok(builtin);
	assert.equal(getGDScriptBuiltinDocumentationClass(builtin.name), "@GDScript");
	assert.equal(builtinToSymbol(builtin).uri, "gdscript://builtin/@GDScript/range");
});

test("GlobalScope builtins retain the @GlobalScope documentation class", () => {
	const builtin = getGDScriptBuiltin("abs");
	assert.ok(builtin);
	assert.equal(getGDScriptBuiltinDocumentationClass(builtin.name), "@GlobalScope");
	assert.equal(builtinToSymbol(builtin).uri, "gdscript://builtin/@GlobalScope/abs");
});

test("builtin prefix lookup is stable", () => {
	const results = getGDScriptBuiltins("print");
	assert.ok(results.some((builtin) => builtin.name === "print"));
	assert.ok(results.every((builtin) => builtin.name.startsWith("print")));
});

test("builtin signatures retain return types and parameters", () => {
	const clamp = getGDScriptBuiltin("clamp");
	assert.deepEqual(clamp?.parameters.map((parameter) => parameter.name), ["value", "min", "max"]);
	assert.equal(clamp?.returnType, "Variant");
});
