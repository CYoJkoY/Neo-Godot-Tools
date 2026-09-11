import { strict as assert } from "node:assert";
import { test } from "node:test";
import { parseGDScript } from "./parser.js";

test("parses top-level GDScript declarations", () => {
	const source = `class_name Player\nextends CharacterBody2D\n\nsignal damaged(amount: int)\nconst SPEED: float = 10.0\nvar health: int = 100\n\nfunc move(direction: Vector2, speed := SPEED) -> void:\n\tposition += direction * speed\n`;
	const result = parseGDScript(source);
	assert.deepEqual(result.diagnostics, []);
	assert.deepEqual(
		result.ast.declarations.map((declaration) => [declaration.kind, declaration.name]),
		[
			["class_name", "Player"],
			["extends", "CharacterBody2D"],
			["signal", "damaged"],
			["constant", "SPEED"],
			["variable", "health"],
			["function", "move"],
		],
	);

	const move = result.ast.declarations[5];
	assert.equal(move.kind, "function");
	if (move.kind === "function") {
		assert.equal(move.parameters[0].type, "Vector2");
		assert.equal(move.parameters[1].defaultValue, "SPEED");
		assert.equal(move.returnType, "void");
		assert.ok(move.bodyRange);
	}
});

test("parses nested classes and enums", () => {
	const source = `class Inventory:\n\tenum Slot { WEAPON, ARMOR }\n\tvar capacity: int = 10\n\nfunc _ready():\n\tpass\n`;
	const result = parseGDScript(source);
	assert.deepEqual(result.diagnostics, []);
	assert.equal(result.ast.declarations.length, 2);
	assert.equal(result.ast.declarations[0].kind, "class");
	if (result.ast.declarations[0].kind === "class") {
		assert.equal(result.ast.declarations[0].declarations[0].kind, "enum");
		assert.deepEqual(result.ast.declarations[0].declarations[0].members, ["WEAPON", "ARMOR"]);
	}
});
