import { strict as assert } from "node:assert";
import { test } from "node:test";
import { parseGDScript } from "./parser.js";

test("records decorating annotations without changing declaration ranges", () => {
	const source = 'class_name Sample\r\n@export_group("Stats")\r\n## Speed.\r\n@export_range(\r\n\t0, 10\r\n)\r\n@onready\r\n\r\nvar speed = 1\r\nvar plain = 2\r\n';
	const declarations = parseGDScript(source).ast.declarations;
	assert.deepEqual(declarations.map((node) => [node.name, node.annotationStartLine, node.range.start.line]), [
		["Sample", undefined, 0],
		["speed", 3, 8],
		["plain", undefined, 9],
	]);
});

test("keeps an enclosing declaration after an orphaned inner annotation", () => {
	const result = parseGDScript("class Inner:\n\t@export\nvar outer = 1\n");
	assert.deepEqual(result.ast.declarations.map((node) => node.name), ["Inner", "outer"]);
	const inner = result.ast.declarations[0];
	assert.equal(inner.kind, "class");
	if (inner.kind === "class") assert.deepEqual(inner.declarations, []);
});

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

test("keeps a function body open across blank and comment-only lines", () => {
	const source = `extends Node\n\nfunc with_gaps() -> void:\n\tvar before := 1\n\n\t# detached note\n\n\tvar after := before + 1\n\tprint(after)\n\nfunc next_one() -> void:\n\tpass\n`;
	const result = parseGDScript(source);
	assert.deepEqual(result.diagnostics, []);
	assert.deepEqual(
		result.ast.declarations.map((declaration) => `${declaration.kind}:${declaration.name}`),
		["extends:Node", "function:with_gaps", "function:next_one"],
	);

	const withGaps = result.ast.declarations[1];
	assert.equal(withGaps.kind, "function");
	if (withGaps.kind !== "function") return;
	const body = withGaps.bodyRange;
	assert.ok(body);
	if (!body) return;
	const bodySource = source.slice(body.start.offset, body.end.offset);
	assert.equal(body.start.line, 3);
	assert.match(bodySource, /var before := 1/);
	assert.match(bodySource, /var after := before \+ 1/);
	assert.match(bodySource, /print\(after\)\n?$/);
	assert.doesNotMatch(bodySource, /func next_one/);
});

test("does not promote statements after a blank line to inner class members", () => {
	const source = `class Inner:\n\tfunc helper() -> void:\n\t\tvar before := 1\n\n\t\tvar after := before + 1\n\t\tprint(after)\n`;
	const result = parseGDScript(source);
	assert.deepEqual(result.diagnostics, []);
	const inner = result.ast.declarations[0];
	assert.equal(inner.kind, "class");
	if (inner.kind !== "class") return;
	assert.deepEqual(
		inner.declarations.map((declaration) => `${declaration.kind}:${declaration.name}`),
		["function:helper"],
	);
	const helper = inner.declarations[0];
	assert.equal(helper.kind, "function");
	if (helper.kind !== "function" || !helper.bodyRange) return;
	const bodySource = source.slice(helper.bodyRange.start.offset, helper.bodyRange.end.offset);
	assert.match(bodySource, /var after := before \+ 1/);
	assert.match(bodySource, /print\(after\)\n?$/);
	assert.equal(inner.range.end.offset, helper.range.end.offset);
});
