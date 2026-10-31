import { strict as assert } from "node:assert";
import * as fs from "node:fs";
import { after, test } from "node:test";

import { parseGDScript } from "../analyzer/parser.js";
import { createZigBackend, resolveZigBackendExecutable, zigBackendRequiresBuiltBinary } from "./zig_backend.js";

interface ParseCase {
	readonly name: string;
	readonly source: string;
}

const isRegularFile = (candidate: string): boolean => {
	try {
		return fs.statSync(candidate).isFile();
	} catch {
		return false;
	}
};

const availability = resolveZigBackendExecutable(__dirname, process.env, process.platform, isRegularFile);
const requiresBinary = zigBackendRequiresBuiltBinary(process.env);
const binarySkip =
	availability.kind === "resolved" || requiresBinary
		? false
		: 'Zig backend binary is not built. Run "npm run build:backend", or set NEO_GODOT_TOOLS_REQUIRE_ZIG_BACKEND=1 to fail instead of skipping.';

const backend = createZigBackend();
after(() => backend.shutdown());

const parseCases: readonly ParseCase[] = [
	{
		name: "top level declarations",
		source: [
			"class_name Player",
			"extends CharacterBody2D",
			"",
			"signal damaged(amount: int)",
			"const SPEED: float = 10.0",
			"var health: int = 100",
			"",
			"func move(direction: Vector2, speed := SPEED) -> void:",
			"\tposition += direction * speed",
			"",
		].join("\n"),
	},
	{
		name: "nested classes and enums",
		source: [
			"class Inventory:",
			"\tenum Slot { WEAPON, ARMOR = 2 }",
			"\tvar capacity: int = 10",
			"",
			"func _ready():",
			"\tpass",
			"",
		].join("\n"),
	},
	{
		name: "annotations and static functions",
		source: [
			"extends Node",
			"@export_range(0, 100) var speed := 1.0",
			"@onready var label: Label = $Label",
			"static func make(value: int = 4) -> Node:",
			"\treturn Node.new()",
			"",
		].join("\n"),
	},
	{
		name: "anonymous enum",
		source: "enum { ALPHA, BETA }\n",
	},
	{
		name: "inner class extends",
		source: "class Worker extends Base:\n\tvar id: int\n",
	},
	{
		name: "crlf line endings",
		source: 'class_name Profile\r\nvar one: int = 1\r\nvar two := {"a": 1}\r\n',
	},
	{
		name: "mixed line endings",
		source: "var a = 1\r\nvar b = 2\nvar c = 3\rvar d = 4\r\n\n",
	},
	{
		name: "unicode and lone surrogates",
		source: '# \u4e2d\u6587\nvar label = "\u4f60\u597d\uff0c\u4e16\u754c"\nvar lone = "\uD83D"\nvar low = "\uDE00"\n',
	},
	{
		name: "malformed declarations",
		source: ["class_name", "extends", "signal", "var = 1", "func (broken:", "class :", "var ok = [1, 2", ""].join(
			"\n",
		),
	},
	{
		name: "function body statements do not leak",
		source: "func run():\n\tvar speed := 1\n\tif speed > 0:\n\t\tpass\n\nvar after = 2\n",
	},
	{
		name: "empty input",
		source: "",
	},
	{
		name: "whitespace only input",
		source: "   \n\t\t\n \t ",
	},
];

parseCases.map((entry) => {
	test(`matches parseGDScript for ${entry.name}`, { skip: binarySkip }, async () => {
		const actual = await backend.parse(entry.source);
		assert.deepEqual(actual, parseGDScript(entry.source), entry.name);
	});
	return entry;
});

test("advertises the parse capability", { skip: binarySkip }, async () => {
	const adapter = createZigBackend();
	assert.equal(adapter.capabilities.parse, false);
	await adapter.parse("var x = 1\n");
	assert.equal(adapter.capabilities.parse, true);
	await adapter.shutdown();
});

test("answers concurrent parse requests without crossing results", { skip: binarySkip }, async () => {
	const sources = [
		"class_name First\nvar one = 1\n",
		"func second() -> void:\n\tpass\n",
		'var third = "\u4e09\u4e2a\u8bf7\u6c42"\n',
		"enum { A, B, C }\n",
	];
	const results = await Promise.all(sources.map((source) => backend.parse(source)));
	results.forEach((result, index) => {
		assert.deepEqual(result, parseGDScript(sources[index]), `concurrent request ${index}`);
	});
});

test("rejects parse after shutdown", { skip: binarySkip }, async () => {
	const adapter = createZigBackend();
	await adapter.shutdown();
	await assert.rejects(adapter.parse("var x = 1\n"), /shut down/);
});
