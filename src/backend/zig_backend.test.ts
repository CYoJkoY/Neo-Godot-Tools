import { strict as assert } from "node:assert";
import * as fs from "node:fs";
import { after, test } from "node:test";

import { lexGDScript } from "../analyzer/lexer.js";
import { createZigBackend, resolveZigBackendExecutable, zigBackendRequiresBuiltBinary } from "./zig_backend.js";

interface LexCase {
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

const lexCases: readonly LexCase[] = [
	{
		name: "declarations with indented bodies",
		source: [
			"extends Node",
			"",
			"@export var health: int = 100",
			"const SPEED := 12.5",
			"",
			"func _ready() -> void:",
			"\tif health > 0:",
			'\t\tprint("alive")',
			"\telse:",
			"\t\tprint('dead')",
			"",
		].join("\n"),
	},
	{
		name: "lf crlf and mixed line endings",
		source: "var a = 1\r\nvar b = 2\nvar c = 3\rvar d = 4\r\n\n",
	},
	{
		name: "trailing newline after a comment",
		source: "var value = 1\n# done\n",
	},
	{
		name: "tabs spaces and mixed indentation",
		source: "func f():\n\tvar a = 1\n    var b = 2\n\t var c = 3\n \tvar d = 4\n",
	},
	{
		name: "unicode text and comments",
		source: '# \u4e2d\u6587\u6ce8\u91ca with ascii\nvar label = "\u4f60\u597d\uff0c\u4e16\u754c"\n# trailing comment',
	},
	{
		name: "non bmp characters and lone surrogates",
		source: [
			'var pair = "\u{1F600}"',
			'var lone = "\uD83D"',
			'var low = "\uDE00"',
			"# lone \uD83D comment",
			'var mixed = "\uD83D\uDE00\uD83D"',
		].join("\n"),
	},
	{
		name: "string escapes and unterminated strings",
		source: [
			'var a = "quote: \\" slash: \\\\ newline: \\n"',
			"var b = 'single \\' quote'",
			'var c = "unterminated',
			'var d = "tail\\',
		].join("\n"),
	},
	{
		name: "three and two character operators",
		source: [
			"var a = b -> c",
			"var d := e ** f",
			"var g = h ... i",
			"var j = k << 2",
			"var l = m && n || o",
			"var p += q -= r",
			"var s == t != u <= v >= w",
		].join("\n"),
	},
	{
		name: "numbers and punctuation",
		source: "var n = 1.2.3\nvar m = 0x1F + 3.14e-2\n@onready var node: Node2D = $Body\n",
	},
	{
		name: "unknown characters",
		source: "var a = 1 ` 2 \u00a7 3 \u{1F600} 4\n",
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

lexCases.map((entry) => {
	test(`matches lexGDScript for ${entry.name}`, { skip: binarySkip }, async () => {
		const actual = await backend.lex(entry.source);
		assert.deepEqual(actual, lexGDScript(entry.source), entry.name);
	});
	return entry;
});

test("answers concurrent requests without crossing results", { skip: binarySkip }, async () => {
	const sources = [
		"var first = 1\n",
		"func second() -> void:\n\tpass\n",
		'var third = "\u4e09\u4e2a\u8bf7\u6c42"\n',
		"# fourth\nvar fourth = 4\n",
	];
	const results = await Promise.all(sources.map((source) => backend.lex(source)));
	results.forEach((tokens, index) => {
		assert.deepEqual(tokens, lexGDScript(sources[index]), `concurrent request ${index}`);
	});
});

test("rejects an oversized lex request locally and keeps the backend alive", { skip: binarySkip }, async () => {
	const adapter = createZigBackend();
	await assert.rejects(adapter.lex("a".repeat(7 * 1024 * 1024)), /exceeds the 16777216 byte limit/);
	assert.deepEqual(await adapter.lex("var x = 1\n"), lexGDScript("var x = 1\n"));
	await adapter.shutdown();
});

test("reassembles frames that arrive across many stdout chunks", { skip: binarySkip }, async () => {
	const adapter = createZigBackend();
	const source = Array.from({ length: 4000 }, (_, index) => `var value_${index} = "text ${index}"`).join("\n");
	assert.deepEqual(await adapter.lex(source), lexGDScript(source));
	await adapter.shutdown();
});

test("shuts down cleanly and rejects lex after shutdown", { skip: binarySkip }, async () => {
	const adapter = createZigBackend();
	assert.deepEqual(await adapter.lex("var x = 1\n"), lexGDScript("var x = 1\n"));
	await adapter.shutdown();
	await adapter.shutdown();
	await assert.rejects(adapter.lex("var y = 2\n"), /shut down/);
});

test("shutdown before any request resolves without starting a process", { skip: binarySkip }, async () => {
	const adapter = createZigBackend();
	await adapter.shutdown();
	await adapter.shutdown();
	await assert.rejects(adapter.lex("var x = 1\n"), /shut down/);
});

test("pre-aborted requests reject without starting the backend", { skip: binarySkip }, async () => {
	const adapter = createZigBackend();
	const controller = new AbortController();
	controller.abort();
	await assert.rejects(adapter.lex("var x = 1\n", { signal: controller.signal }), { name: "AbortError" });
	await adapter.shutdown();
});

test("advertises the symbol capability only after the handshake", { skip: binarySkip }, async () => {
	const adapter = createZigBackend();
	assert.deepEqual(adapter.capabilities, { lex: false, symbols: false });
	await assert.rejects(adapter.ingestSymbols(1, []), /symbols capability/);
	await adapter.lex("var x = 1\n");
	assert.deepEqual(adapter.capabilities, { lex: true, symbols: true });
	await adapter.shutdown();
});

test("ingest returns ids in input order and queries them in workspace order", { skip: binarySkip }, async () => {
	const adapter = createZigBackend();
	await adapter.lex("");
	const result = await adapter.ingestSymbols(3, [
		{
			uri: "file:///a.gd",
			symbols: [
				{ name: "script_10", start: 10, end: 19 },
				{ name: "script_2", start: 20, end: 28 },
			],
		},
		{ uri: "file:///b.gd", symbols: [{ name: "getValue", start: 5, end: 13 }] },
	]);
	assert.equal(result.revision, 3);
	assert.deepEqual(
		result.files.map((file) => ({ uri: file.uri, ids: [...file.ids] })),
		[
			{ uri: "file:///a.gd", ids: [1, 2] },
			{ uri: "file:///b.gd", ids: [3] },
		],
	);
	assert.deepEqual([...(await adapter.querySymbols(3, "script"))], [1, 2]);
	assert.deepEqual([...(await adapter.querySymbols(3, "value"))], [3]);
	assert.deepEqual([...(await adapter.querySymbols(3, ""))], [3, 1, 2]);
	assert.deepEqual(await adapter.digestSymbols(), { revision: 3, files: 2, symbols: 3 });
	await adapter.shutdown();
});

test("rejects a stale revision after remove and clear", { skip: binarySkip }, async () => {
	const adapter = createZigBackend();
	await adapter.lex("");
	await adapter.ingestSymbols(1, [
		{ uri: "file:///a.gd", symbols: [{ name: "alpha", start: 0, end: 5 }] },
		{ uri: "file:///b.gd", symbols: [{ name: "beta", start: 0, end: 4 }] },
	]);
	assert.equal(await adapter.removeSymbols(2, "file:///a.gd"), 2);
	assert.deepEqual(await adapter.digestSymbols(), { revision: 2, files: 1, symbols: 1 });
	await assert.rejects(adapter.querySymbols(1, ""), /stale revision/);
	// Removing an unknown file is still a revision advance, exactly like the store.
	assert.equal(await adapter.removeSymbols(3, "file:///missing.gd"), 3);
	assert.equal(await adapter.clearSymbols(4), 4);
	assert.deepEqual(await adapter.digestSymbols(), { revision: 4, files: 0, symbols: 0 });
	await adapter.shutdown();
});

test("rejects non ascii symbol names and uris", { skip: binarySkip }, async () => {
	const adapter = createZigBackend();
	await adapter.lex("");
	await assert.rejects(
		adapter.ingestSymbols(1, [{ uri: "file:///\u00e9.gd", symbols: [{ name: "alpha", start: 0, end: 5 }] }]),
		/printable ascii/,
	);
	await assert.rejects(
		adapter.ingestSymbols(1, [{ uri: "file:///a.gd", symbols: [{ name: "\u4f60\u597d", start: 0, end: 2 }] }]),
		/printable ascii/,
	);
	await adapter.ingestSymbols(2, [{ uri: "file:///a.gd", symbols: [{ name: "alpha", start: 0, end: 5 }] }]);
	await assert.rejects(adapter.querySymbols(2, "\u4f60"), /printable ascii/);
	await adapter.shutdown();
});

test("resolves an absolute executable override", () => {
	const executable = "/opt/neo/neo-godot-backend";
	const result = resolveZigBackendExecutable(
		"/workspace/out-test/src/backend",
		{ NEO_GODOT_TOOLS_ZIG_BACKEND: executable },
		"linux",
		(candidate) => candidate === executable,
	);
	assert.deepEqual(result, { kind: "resolved", executable });
});

test("rejects a relative executable override", () => {
	const result = resolveZigBackendExecutable(
		"/workspace/out-test/src/backend",
		{ NEO_GODOT_TOOLS_ZIG_BACKEND: "backend/zig-out/bin/neo-godot-backend" },
		"linux",
		() => true,
	);
	assert.equal(result.kind, "invalid-environment");
	if (result.kind !== "invalid-environment") return;
	assert.match(result.message, /must be an absolute path/);
});

test("appends the executable suffix on windows", () => {
	const seen: string[] = [];
	const result = resolveZigBackendExecutable(
		"C:\\workspace\\out-test\\src\\backend",
		{ NEO_GODOT_TOOLS_ZIG_BACKEND: "C:\\tools\\neo-godot-backend" },
		"win32",
		(candidate) => {
			seen.push(candidate);
			return true;
		},
	);
	assert.deepEqual(seen, ["C:\\tools\\neo-godot-backend.exe"]);
	assert.deepEqual(result, { kind: "resolved", executable: "C:\\tools\\neo-godot-backend.exe" });
});

test("reports a missing executable with build instructions", () => {
	const result = resolveZigBackendExecutable("/workspace/out-test/src/backend", {}, "linux", () => false);
	assert.equal(result.kind, "missing");
	if (result.kind !== "missing") return;
	assert.match(result.message, /npm run build:backend/);
	assert.equal(result.candidates.length, 3);
	result.candidates.map((candidate) => {
		assert.equal(candidate.endsWith("neo-godot-backend"), true, candidate);
		return candidate;
	});
});
