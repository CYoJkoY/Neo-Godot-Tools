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

interface TestElement {
	tagName: string;
	className: string;
	value: string;
	textContent: string;
	checked: boolean;
	disabled: boolean;
	hidden: boolean;
	title: string;
	id?: string;
	selectionStart?: number | null;
	selectionEnd?: number | null;
	focus(): void;
	setSelectionRange(start: number, end: number): void;
	getAttribute(name: string): string | null;
	querySelectorAll(selector: string): TestElement[];
	min?: string;
	max?: string;
	step?: string;
	attributes: Record<string, string>;
	children: TestElement[];
	listeners: Record<string, (event?: unknown) => void>;
	setAttribute(name: string, value: unknown): void;
	appendChild(child: TestElement): TestElement;
}

/** Payloads the panel script posts back to the extension host. */
interface WebviewMessage {
	command: string;
	target?: string;
	name?: string;
}

interface WebviewSandbox {
	listForm(raw: string): { name: string; body: string; wrapped: boolean };
	parseList(raw: string): string[];
	serializeList(form: { name: string; body: string; wrapped: boolean }, items: string[]): string;
	defaultListEntry(form: { name: string; body: string; wrapped: boolean }): string;
	splitTopLevel(text: string): string[];
	normalizeNumericValue(raw: string, options: Record<string, unknown>): number | undefined;
	numberInput(value: number | string, options: Record<string, unknown>, commit: (value: string) => void): TestElement;
	propertyRow(
		property: Record<string, unknown>,
		model: unknown,
		commit: (...args: unknown[]) => void,
		revert: (...args: unknown[]) => void,
	): TestElement;
	render(model: unknown): void;
	document: { body: TestElement; activeElement?: TestElement; getElementById(id: string): TestElement };
	messages: WebviewMessage[];
}

function loadWebview(): WebviewSandbox {
	const html = resourceInspectorHtml({ cspSource: "https://webview.example" } as vscode.Webview, {} as vscode.Uri);
	const script = html.match(/<script[^>]*>([\s\S]*?)<\/script>/)?.[1];
	assert.ok(script, "webview must contain its nonced script");
	const messages: unknown[] = [];
	let activeElement: TestElement | undefined;
	class StubElement implements TestElement {
		tagName: string;
		className = "";
		value = "";
		checked = false;
		disabled = false;
		hidden = false;
		title = "";
		id?: string;
		selectionStart?: number | null;
		selectionEnd?: number | null;
		min?: string;
		max?: string;
		step?: string;
		attributes: Record<string, string> = {};
		children: TestElement[] = [];
		listeners: Record<string, (event?: unknown) => void> = {};
		style: Record<string, string> = {};
		classList = { contains: (name: string) => this.className.split(" ").includes(name) };
		private text = "";

		constructor(tag = "div") {
			this.tagName = tag;
		}

		get textContent(): string {
			return this.text;
		}

		set textContent(value: string) {
			this.text = value;
			this.children = [];
		}

		addEventListener(event: string, listener: (event?: unknown) => void) {
			this.listeners[event] = listener;
		}

		removeEventListener() {}

		setAttribute(name: string, value: unknown) {
			this.attributes[name] = String(value);
			if (name === "title") this.title = String(value);
			if (name === "id") this.id = String(value);
		}

		getAttribute(name: string) {
			return this.attributes[name] ?? null;
		}

		focus() {
			activeElement = this;
		}

		setSelectionRange(start: number, end: number) {
			this.selectionStart = start;
			this.selectionEnd = end;
		}

		querySelectorAll(selector: string) {
			const matches = (field: TestElement) =>
				selector.split(",").some((part) => {
					const query = part.trim();
					return query.startsWith(".")
						? field.className.split(" ").includes(query.slice(1))
						: query.startsWith("[")
							? field.getAttribute(query.slice(1, -1)) !== null
							: field.tagName === query;
				});
			return this.children.flatMap((child) => descendants(child, matches));
		}

		appendChild(child: TestElement) {
			this.children.push(child);
			return child;
		}
	}

	const makeElement = (tag = "div"): TestElement => new StubElement(tag);
	const app = makeElement();
	const body = makeElement("body");
	const sandbox = {
		acquireVsCodeApi: () => ({ postMessage: (message: unknown) => messages.push(message) }),
		document: {
			body,
			createElement: makeElement,
			get activeElement() {
				return activeElement;
			},
			getElementById: (id: string) =>
				id === "app" ? app : (descendants(app, (el) => el.id === id)[0] ?? makeElement()),
		},
		window: { addEventListener: () => {} },
		messages,
	};
	vm.createContext(sandbox);
	vm.runInContext(script, sandbox);
	return sandbox as unknown as WebviewSandbox;
}

/** Invokes the listener the panel script registered for `type`. */
function fire(element: TestElement, type: string, event?: unknown): void {
	const listener = element.listeners[type];
	assert.ok(listener, `expected a '${type}' listener`);
	listener(event);
}

function descendants(root: TestElement, predicate: (el: TestElement) => boolean): TestElement[] {
	return [root, ...root.children.flatMap((child) => descendants(child, predicate))].filter(predicate);
}

describe("resource inspector webview", () => {
	it("routes sub-resource property edits to their owning resource", () => {
		const webview = loadWebview();
		const edits: unknown[][] = [];
		const row = webview.propertyRow(
			{
				name: "roughness",
				raw: "0.4",
				target: "StandardMaterial3D_1",
				metadata: { type: "float", defaultValue: "0.5" },
				widget: { kind: "text" },
			},
			{},
			(...args) => edits.push(args),
			() => {},
		);
		fire(row.children[1], "change", { target: { value: "0.8" } });
		assert.deepEqual(edits[0], ["roughness", "0.8", "StandardMaterial3D_1"]);
	});

	it("renders Script as one working selector without a duplicate text field", () => {
		const webview = loadWebview();
		const edits: unknown[][] = [];
		const row = webview.propertyRow(
			{
				name: "script",
				raw: 'ExtResource("7_script")',
				definedInFile: true,
				modified: true,
				metadata: { name: "script", type: "Script", defaultValue: "null", source: "builtin" },
				widget: { kind: "resource" },
			},
			{
				format: "3",
				extResources: [
					{ id: "7_script", type: "Script", path: "res://a_very_long_script_name.gd" },
					{ id: "8_tex", type: "Texture2D", path: "res://texture.png" },
				],
				subResources: [],
			},
			(...args) => edits.push(args),
			() => {},
		);
		const fields = descendants(row, (el) => ["input", "select", "textarea"].includes(el.tagName));
		assert.equal(fields.length, 1);
		assert.equal(fields[0].tagName, "select");
		assert.equal(fields[0].value, 'ExtResource("7_script")');
		assert.equal(fields[0].children.length, 2, "only None and the compatible script");
		fields[0].value = "null";
		fire(fields[0], "change");
		assert.deepEqual(edits[0], ["script", "null", undefined]);
	});

	it("preserves legacy and missing resource references", () => {
		const webview = loadWebview();
		const edits: unknown[][] = [];
		const property = {
			name: "script",
			raw: "ExtResource( 7 )",
			widget: { kind: "resource" },
			metadata: { type: "Script" },
		};
		const row = webview.propertyRow(
			property,
			{ format: "2", extResources: [{ id: "7", type: "Script" }], subResources: [] },
			(...args) => edits.push(args),
			() => {},
		);
		const picker = descendants(row, (el) => el.tagName === "select")[0];
		assert.equal(picker.value, "ExtResource( 7 )");
		fire(picker, "change");
		assert.equal(edits[0][1], "ExtResource( 7 )");
		const missing = webview.propertyRow(
			{ ...property, raw: 'ExtResource("missing")' },
			{},
			() => {},
			() => {},
		);
		assert.equal(descendants(missing, (el) => el.tagName === "select")[0].value, 'ExtResource("missing")');
	});

	it("clamps bounds, snaps steps, keeps fractional values and rejects empty input", () => {
		const webview = loadWebview();
		const values: string[] = [];
		const input = webview.numberInput("2", { min: 0, max: 1, step: 0.01 }, (value) => values.push(value));
		assert.equal(input.value, "2", "rendering an out-of-range value must not edit the document");
		input.value = "3.5";
		fire(input, "change");
		input.value = "-0.1";
		fire(input, "change");
		input.value = "0.254";
		fire(input, "change");
		input.value = "";
		fire(input, "change");
		assert.deepEqual(values, ["1", "0", "0.25"]);
		assert.equal(input.value, "0.25", "invalid typing restores the last accepted value");
		assert.equal(webview.normalizeNumericValue("Infinity", {}), undefined);
		assert.equal(webview.normalizeNumericValue("9.7", { integer: true, min: 0, max: 10 }), 10);
		const unbounded = webview.numberInput(0.5, {}, () => {});
		assert.equal(unbounded.getAttribute("step"), "any", "HTML's implicit step=1 must not reject fractions");
		assert.equal(webview.normalizeNumericValue("2.5", { min: 0, max: 1, step: 0.1, allowGreater: true }), 2.5);
		assert.equal(webview.normalizeNumericValue("-2", { min: 0, max: 1, allowLesser: true }), -2);
	});

	it("synchronizes bounded sliders and commits only when dragging finishes", () => {
		const webview = loadWebview();
		const edits: unknown[][] = [];
		const row = webview.propertyRow(
			{ name: "roughness", raw: "0.5", widget: { kind: "number", min: 0, max: 1, step: 0.01 } },
			{},
			(...args) => edits.push(args),
			() => {},
		);
		const inputs = descendants(row, (el) => el.tagName === "input");
		assert.equal(inputs.length, 2);
		const slider = inputs[1];
		slider.value = "0.73";
		fire(slider, "input");
		assert.equal(inputs[0].value, "0.73");
		assert.equal(edits.length, 0);
		fire(slider, "change");
		assert.deepEqual(edits[0], ["roughness", "0.73", undefined]);
		inputs[0].value = "0.4";
		fire(inputs[0], "change");
		assert.equal(slider.value, "0.4");
		const hiddenSlider = webview.propertyRow(
			{ name: "gain", raw: "0.5", widget: { kind: "number", min: 0, max: 1, hideSlider: true } },
			{},
			() => {},
			() => {},
		);
		assert.equal(descendants(hiddenSlider, (el) => el.tagName === "input").length, 1);
	});

	it("edits vector components without parsing digits in constructor names", () => {
		const webview = loadWebview();
		const edits: unknown[][] = [];
		const row = webview.propertyRow(
			{ name: "position", raw: "Vector2(1e-3, -2.5)", widget: { kind: "vector", components: 2 } },
			{},
			(...args) => edits.push(args),
			() => {},
		);
		const inputs = descendants(row, (el) => el.tagName === "input");
		assert.equal(inputs[0].value, "0.001");
		assert.equal(inputs[1].value, "-2.5");
		inputs[0].value = "3.25";
		fire(inputs[0], "change");
		assert.equal(edits[0][1], "Vector2(3.25, -2.5)");
		const integerRow = webview.propertyRow(
			{ name: "position", raw: "Vector2i(1, 2)", widget: { kind: "vector", components: 2, integer: true } },
			{},
			(...args) => edits.push(args),
			() => {},
		);
		const integerInput = descendants(integerRow, (el) => el.tagName === "input")[0];
		integerInput.value = "3.7";
		fire(integerInput, "change");
		assert.equal(edits[1][1], "Vector2i(4, 2)");
	});

	it("uses authoritative modified state and removes unknown overrides", () => {
		const webview = loadWebview();
		const reverts: unknown[][] = [];
		const row = webview.propertyRow(
			{
				name: "custom",
				raw: "8",
				definedInFile: true,
				modified: true,
				metadata: { type: "int", source: "lsp" },
				widget: { kind: "number" },
			},
			{},
			() => {},
			(...args) => reverts.push(args),
		);
		assert.ok(row.className.includes("modified"));
		const revert = row.children[2];
		assert.equal(revert.title, "Remove override");
		fire(revert, "click");
		assert.deepEqual(reverts[0], ["custom", undefined, undefined]);
		const defaultRow = webview.propertyRow(
			{
				name: "value",
				raw: "1",
				definedInFile: true,
				modified: false,
				metadata: { source: "builtin", defaultValue: "1.0" },
				widget: { kind: "number" },
			},
			{},
			() => {},
			() => {},
		);
		assert.ok(!defaultRow.className.includes("modified"));
		const placeholder = webview.propertyRow(
			{ name: "value", raw: "0", definedInFile: false, modified: false, widget: { kind: "number" } },
			{},
			() => {},
			() => {},
		);
		assert.equal(placeholder.children[2].disabled, true);
		assert.match(placeholder.children[0].title, /placeholder/);
	});

	it("keeps field focus and text selection across model updates, not across files", () => {
		const webview = loadWebview();
		const model = {
			uri: "file:///one.tres",
			resourceType: "Resource",
			properties: [{ name: "title", raw: '"old"', widget: { kind: "text" }, modified: false }],
			subResources: [],
			extResources: [],
		};
		webview.render(model);
		const app = webview.document.getElementById("app");
		const field = descendants(app, (el) => el.attributes["aria-label"] === "title")[0];
		field.focus();
		field.setSelectionRange(2, 4);
		webview.render({ ...model, properties: [{ ...model.properties[0], raw: '"new value"' }] });
		const updated = descendants(app, (el) => el.attributes["aria-label"] === "title")[0];
		assert.notEqual(updated, field);
		assert.equal(webview.document.activeElement, updated);
		assert.equal(updated.selectionStart, 2);
		assert.equal(updated.selectionEnd, 4);
		webview.render({ ...model, uri: "file:///two.tres" });
		const otherFileField = descendants(app, (el) => el.attributes["aria-label"] === "title")[0];
		assert.notEqual(webview.document.activeElement, otherFileField);
	});

	it("keeps picker focus when an image thumbnail appears before it", () => {
		const webview = loadWebview();
		const property = {
			name: "texture",
			raw: "null",
			widget: { kind: "resource" },
			metadata: { type: "Texture2D" },
		};
		const model = {
			uri: "file:///one.tres",
			resourceType: "Resource",
			properties: [property],
			subResources: [],
			extResources: [{ id: "1", type: "Texture2D", path: "res://one.svg" }],
		};
		webview.render(model);
		const app = webview.document.getElementById("app");
		descendants(app, (el) => el.tagName === "select")[0].focus();
		webview.render({
			...model,
			properties: [
				{
					...property,
					raw: 'ExtResource("1")',
					imagePreview: { path: "res://one.svg", uri: "https://webview.example/one.svg" },
				},
			],
		});
		assert.equal(webview.document.activeElement, descendants(app, (el) => el.tagName === "select")[0]);
	});

	it("keeps the Modified filter keyboard-focusable after it re-renders", () => {
		const webview = loadWebview();
		webview.render({
			uri: "file:///one.tres",
			resourceType: "Resource",
			properties: [],
			subResources: [],
			extResources: [],
		});
		const filter = webview.document.getElementById("modified-filter");
		filter.focus();
		fire(filter, "click");
		assert.equal(webview.document.activeElement, webview.document.getElementById("modified-filter"));
	});

	it("supports custom enum values and multi-select flags without losing unknown bits", () => {
		const webview = loadWebview();
		const edits: unknown[][] = [];
		const enumRow = webview.propertyRow(
			{
				name: "state",
				raw: "3",
				metadata: { type: "int" },
				widget: { kind: "enum", options: ["Idle:2", "Run", "Jump:5", "Fall"] },
			},
			{},
			() => {},
			() => {},
		);
		const picker = enumRow.children[1];
		assert.equal(picker.value, "3");
		assert.deepEqual(
			picker.children.map((child) => child.value),
			["2", "3", "5", "6"],
		);
		const flagRow = webview.propertyRow(
			{ name: "flags", raw: "8", metadata: { type: "int" }, widget: { kind: "flags", options: ["A", "B"] } },
			{},
			(...args) => edits.push(args),
			() => {},
		);
		const checkbox = descendants(flagRow, (el) => el.tagName === "input")[0];
		checkbox.checked = true;
		fire(checkbox, "change");
		assert.equal(edits[0][1], "9", "keep unrecognized bit 8 when enabling bit 1");
	});

	it("shows image previews on hover and keyboard focus and routes image opening", () => {
		const webview = loadWebview();
		const preview = { path: "res://art/icon.svg", uri: "https://webview.example/art/icon.svg" };
		const row = webview.propertyRow(
			{
				name: "image_path",
				raw: '"res://art/icon.svg"',
				target: "Custom_1",
				widget: { kind: "text" },
				metadata: { type: "String" },
				imagePreview: preview,
			},
			{},
			() => {},
			() => {},
		);
		const thumbnail = descendants(row, (el) => el.className === "image-thumbnail")[0];
		const image = thumbnail.children[0];
		assert.equal(image.getAttribute("src"), preview.uri);
		fire(row.children[1], "mouseenter");
		const popup = webview.document.body.children[0];
		assert.equal(popup.hidden, false);
		assert.equal(popup.children[0].getAttribute("src"), preview.uri);
		assert.equal(popup.children[1].textContent, preview.path);
		fire(row.children[1], "mouseleave");
		assert.equal(popup.hidden, true);
		fire(thumbnail, "focusin");
		assert.equal(popup.hidden, false);
		fire(thumbnail, "click");
		assert.equal(webview.messages.at(-1)?.command, "openImage");
		assert.equal(webview.messages.at(-1)?.target, "Custom_1");
		assert.equal(webview.messages.at(-1)?.name, "image_path");
		fire(popup.children[0], "error");
		assert.equal(popup.children.at(-1)?.textContent, "Unable to load image preview.");
	});

	it("restricts images with CSP and authorizes only its nonced script", () => {
		const html = resourceInspectorHtml(
			{ cspSource: "https://webview.example" } as vscode.Webview,
			{} as vscode.Uri,
		);
		assert.match(html, /default-src 'none'/);
		assert.match(html, /img-src https:\/\/webview.example/);
		const nonce = html.match(/script-src 'nonce-([a-f0-9]+)'/)?.[1];
		assert.ok(nonce);
		assert.ok(html.includes(`<script nonce="${nonce}">`));
		assert.ok(!html.includes("script-src 'unsafe-inline'"));
	});

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
