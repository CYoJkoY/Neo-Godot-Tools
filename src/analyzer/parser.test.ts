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

test("keeps AST ranges correct for CRLF and large declaration sets", () => {
	const declarations = Array.from({ length: 120 }, (_, index) => `var value_${index}: int = ${index}`).join("\r\n");
	const source = `class_name Profile\r\n${declarations}\r\n`;
	const result = parseGDScript(source);
	assert.equal(result.ast.declarations.length, 121);
	const firstVariable = result.ast.declarations[1];
	const lastVariable = result.ast.declarations[result.ast.declarations.length - 1];
	assert.equal(firstVariable.range.start.line, 1);
	assert.equal(firstVariable.range.start.character, 0);
	assert.equal(lastVariable.range.start.line, 120);
	assert.equal(
		source.slice(lastVariable.range.start.offset, lastVariable.range.end.offset).startsWith("var value_119"),
		true,
	);
});

test("parses nested classes and enums", () => {
	const source = `class Inventory:\n\tenum Slot { WEAPON, ARMOR }\n\tvar capacity: int = 10\n\nfunc _ready():\n\tpass\n`;
	const result = parseGDScript(source);
	assert.deepEqual(result.diagnostics, []);
	assert.equal(result.ast.declarations.length, 2);
	assert.equal(result.ast.declarations[0].kind, "class");
	if (result.ast.declarations[0].kind === "class") {
		assert.equal(result.ast.declarations[0].declarations[0].kind, "enum");
		assert.deepEqual(
			result.ast.declarations[0].declarations[0].members.map((member) => member.name),
			["WEAPON", "ARMOR"],
		);
	}
});
