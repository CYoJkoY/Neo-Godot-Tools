import { strict as assert } from "node:assert";
import { test } from "node:test";
import { parseGDScript } from "../analyzer/parser.js";
import { collectControlFlowAssignments } from "./control_flow.js";

test("collects assignments from complete branches", () => {
	const source = `func test(flag: bool):\n\tvar value\n\tif flag:\n\t\tvalue = Player.new()\n\telse:\n\t\tvalue = Player.new()\n\treturn value\n`;
	const parsed = parseGDScript(source);
	const fn = parsed.ast.declarations.find((declaration) => declaration.kind === "function");
	assert.ok(fn?.kind === "function");
	const offset = source.lastIndexOf("return value");
	const values = collectControlFlowAssignments(source, fn.bodyRange, "value", offset);
	assert.deepEqual(values, ["Player . new ( )", "Player . new ( )"]);
});

test("does not treat ordinary := outside a branch as control flow", () => {
	const source = `func test():\n\tvar value := Player.new()\n\treturn value\n`;
	const parsed = parseGDScript(source);
	const fn = parsed.ast.declarations.find((declaration) => declaration.kind === "function");
	assert.ok(fn?.kind === "function");
	const values = collectControlFlowAssignments(source, fn.bodyRange, "value", source.lastIndexOf("return value"));
	assert.equal(values, undefined);
});
