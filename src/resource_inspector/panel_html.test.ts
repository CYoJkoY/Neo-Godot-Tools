import { strict as assert } from "node:assert";
import { describe, it } from "node:test";
import * as vm from "node:vm";
import type * as vscode from "vscode";
import { resourceInspectorHtml } from "./panel_html.js";

/**
 * The webview is plain JavaScript embedded in the HTML, so its helpers are
 * exercised by running the script in a sandbox with a minimal DOM. These tests
 * pin down the parts that write back into the resource file: an editor that
 * rewrites `[1, 2]` into `[1, 2]([1, 2])` would corrupt every file it touches.
 */

interface WebviewSandbox {
	listForm(raw: string): { name: string; body: string; wrapped: boolean };
	parseList(raw: string): string[];
	serializeList(form: { name: string; body: string; wrapped: boolean }, items: string[]): string;
	defaultListEntry(form: { name: string; body: string; wrapped: boolean }): string;
	splitTopLevel(text: string): string[];
}

function loadWebview(): WebviewSandbox {
	const html = resourceInspectorHtml({} as vscode.Webview, {} as vscode.Uri);
	const script = html.slice(html.indexOf("<script>") + "<script>".length, html.indexOf("</script>"));

	const messages: unknown[] = [];
	const element = () => ({
		style: {},
		children: [] as unknown[],
		addEventListener: () => {},
		removeEventListener: () => {},
		setAttribute: () => {},
		appendChild: (child: unknown) => child,
	});
	const sandbox = {
		acquireVsCodeApi: () => ({ postMessage: (message: unknown) => messages.push(message) }),
		document: {
			createElement: element,
			getElementById: () => element(),
		},
		window: { addEventListener: () => {} },
		messages,
	};
	vm.createContext(sandbox);
	vm.runInContext(script, sandbox);
	return sandbox as unknown as WebviewSandbox;
}

describe("resource inspector webview", () => {
	it("keeps list containers when entries change", () => {
		const webview = loadWebview();
		const cases: Array<{ raw: string; items: string[]; expected: string }> = [
			{ raw: "[1, 2]", items: ["3", "4"], expected: "[3, 4]" },
			{
				raw: "Array[Vector2]([Vector2(1, 2)])",
				items: ["Vector2(3, 4)"],
				expected: "Array[Vector2]([Vector2(3, 4)])",
			},
			{ raw: 'PackedStringArray("a", "b")', items: ['"a"', '"c"'], expected: 'PackedStringArray("a", "c")' },
			{
				raw: "PackedVector2Array(0, 0, 16, 0)",
				items: ["0", "0", "16", "16"],
				expected: "PackedVector2Array(0, 0, 16, 16)",
			},
			{ raw: "PoolColorArray(1, 0, 0, 1)", items: ["0", "1", "0", "1"], expected: "PoolColorArray(0, 1, 0, 1)" },
			{ raw: "[]", items: [], expected: "[]" },
		];
		for (const testCase of cases) {
			const form = webview.listForm(testCase.raw);
			assert.equal(webview.serializeList(form, testCase.items), testCase.expected, testCase.raw);
		}
	});

	it("reads list entries out of every container", () => {
		const webview = loadWebview();
		// The sandbox runs in its own realm, so its arrays are copied over first.
		const parse = (raw: string) => [...webview.parseList(raw)];
		assert.deepEqual(parse("[1, 2]"), ["1", "2"]);
		assert.deepEqual(parse("Array[Vector2]([Vector2(1, 2), Vector2(3, 4)])"), ["Vector2(1, 2)", "Vector2(3, 4)"]);
		assert.deepEqual(parse('PackedStringArray("a", "b")'), ['"a"', '"b"']);
		// Nested containers and quoted commas stay in one entry.
		assert.deepEqual(parse('[[1, 2], {"a": 1}]'), ["[1, 2]", '{"a": 1}']);
		assert.deepEqual(parse('["a, b", "c"]'), ['"a, b"', '"c"']);
		assert.deepEqual(parse("[]"), []);
	});

	it("suggests a valid placeholder for new entries", () => {
		const webview = loadWebview();
		assert.equal(webview.defaultListEntry(webview.listForm("Array[Vector2]([])")), "Vector2(0, 0)");
		assert.equal(webview.defaultListEntry(webview.listForm("Array[String]([])")), '""');
		assert.equal(webview.defaultListEntry(webview.listForm('PackedStringArray("a")')), '""');
		assert.equal(webview.defaultListEntry(webview.listForm("PackedVector2Array()")), "0");
		assert.equal(webview.defaultListEntry(webview.listForm("[1]")), "null");
	});

	it("splits dictionary bodies on top-level commas only", () => {
		const webview = loadWebview();
		const split = (text: string) => [...webview.splitTopLevel(text)];
		assert.deepEqual(split('"a": 1, "b": [1, 2]'), ['"a": 1', '"b": [1, 2]']);
		assert.deepEqual(split('"a": {"x": 1}, "b": 2'), ['"a": {"x": 1}', '"b": 2']);
		assert.deepEqual(split('"a, b": 1'), ['"a, b": 1']);
		// Godot 4 writes trailing commas.
		assert.deepEqual(split('"a": 1,'), ['"a": 1']);
	});
});
