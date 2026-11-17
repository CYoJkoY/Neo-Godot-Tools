import { strict as assert } from "node:assert";
import { describe, it } from "node:test";
import { DOC_FOCUS_FUNCTION, make_html_content, make_symbol_document } from "./documentation_builder.js";
import type { GodotNativeSymbol } from "./documentation_types.js";

/** vscode `SymbolKind` values, mirrored from the language-client enum. */
const SymbolKind = {
	Class: 4,
	Method: 5,
	Property: 6,
	Constructor: 8,
	Enum: 9,
	Function: 11,
	Variable: 12,
	Constant: 13,
	EnumMember: 21,
	Event: 23,
	Operator: 24,
} as const;

function classSymbol(children: Array<Partial<GodotNativeSymbol>>): GodotNativeSymbol {
	const range = { start: { line: 0, character: 0 }, end: { line: 0, character: 0 } };
	return {
		name: "Node",
		native_class: "Node",
		kind: SymbolKind.Class,
		detail: "",
		documentation: "Base class.",
		range,
		selectionRange: range,
		children: children.map((child) => ({ range, selectionRange: range, ...child })) as GodotNativeSymbol[],
	};
}

const webview = { asWebviewUri: (uri: unknown) => uri } as unknown as Parameters<typeof make_html_content>[0];

describe("documentation anchors", () => {
	it("renders kind-prefixed element ids for every member kind", () => {
		const html = make_symbol_document(
			classSymbol([
				{ name: "abs", kind: SymbolKind.Method, detail: "abs(x: float) -> float", documentation: "" },
				{
					name: "anchor_left",
					kind: SymbolKind.Property,
					detail: "var Control.anchor_left: float",
					documentation: "",
				},
				{
					name: "FOCUS_ALL",
					kind: SymbolKind.Constant,
					detail: "const Control.FOCUS_ALL: FocusMode = 2",
					documentation: "",
				},
				{ name: "changed", kind: SymbolKind.Event, detail: "signal Control.changed()", documentation: "" },
				{ name: "_init", kind: SymbolKind.Constructor, detail: "_init()", documentation: "" },
			]),
		);
		assert.ok(html.includes('id="method-abs"'), "methods use the `method-` anchor prefix");
		assert.ok(html.includes('id="property-anchor_left"'));
		assert.ok(html.includes('id="constant-focus_all"'));
		assert.ok(html.includes('id="signal-changed"'));
		assert.ok(html.includes('id="constructor-_init"'));
		assert.ok(!html.includes('id="abs"'), "plain symbol names are no longer used as ids");
	});

	it("links the index to the same anchor used for navigation", () => {
		const html = make_symbol_document(
			classSymbol([
				{ name: "abs", kind: SymbolKind.Method, detail: "abs(x: float) -> float", documentation: "" },
			]),
		);
		assert.ok(html.includes('href="#method-abs"'));
	});

	it("keeps name based lookups working through data attributes", () => {
		const html = make_symbol_document(
			classSymbol([
				{
					name: "anchor_left",
					kind: SymbolKind.Property,
					detail: "var Control.anchor_left: float",
					documentation: "",
				},
			]),
		);
		assert.ok(html.includes('data-symbol="anchor_left"'));
	});

	it("focuses the exact section of a builtin function", () => {
		const html = make_html_content(
			webview,
			classSymbol([
				{ name: "abs", kind: SymbolKind.Method, detail: "abs(x: float) -> float", documentation: "" },
				{ name: "sign", kind: SymbolKind.Method, detail: "sign(x: float) -> float", documentation: "" },
			]),
			"method-abs",
		);
		assert.ok(html.includes(DOC_FOCUS_FUNCTION.slice(0, 40)));
		assert.ok(html.includes('ngdtFocus("method-abs")'), "the page focuses the requested anchor on load");
		assert.ok(html.includes("document.getElementById(ids[i])"), "the resolver can fall back to candidate ids");
	});

	it("renders `$&` in a code block literally", () => {
		const html = make_symbol_document(
			classSymbol([
				{
					name: "abs",
					kind: SymbolKind.Method,
					detail: "abs(x: float) -> float",
					documentation: 'Example:\n[codeblock]\nvar node = $Node\nprint("$& and $1")\n[/codeblock]',
				},
			]),
		);
		// `$&` reaches the page as `$&amp;` (bbcode escape) and prism escapes the `&`
		// again; what matters is that the marker is not expanded by the replacement.
		assert.ok(html.includes("$&amp;amp; and $1"), "replacement sequences stay inside the code block");
		assert.ok(!html.includes("inspect('codeblock')"), "the block marker is not re-expanded into a link");
	});

	it("emits every class section in the documented order", () => {
		const html = make_symbol_document(
			classSymbol([
				{
					name: "FOCUS_ALL",
					kind: SymbolKind.Constant,
					detail: "const Control.FOCUS_ALL: FocusMode = 2",
					documentation: "",
				},
				{ name: "abs", kind: SymbolKind.Method, detail: "abs(x: float) -> float", documentation: "" },
				{
					name: "anchor_left",
					kind: SymbolKind.Property,
					detail: "var Control.anchor_left: float",
					documentation: "",
				},
			]),
		);
		const order = ["Properties", "Methods", "Constants", "Property Descriptions", "Method Descriptions"].map(
			(title) => html.indexOf(`>${title}</h3>`),
		);
		assert.ok(
			order.every((position) => position >= 0),
			"each section heading is rendered",
		);
		assert.deepEqual(
			order,
			[...order].sort((left, right) => left - right),
			"sections keep the documented order",
		);
	});

	it("renders properties whose names contain slashes", () => {
		const html = make_symbol_document(
			classSymbol([
				{
					name: "application/boot_splash/bg_color",
					kind: SymbolKind.Property,
					detail: "var ProjectSettings.application/boot_splash/bg_color: Color",
					documentation: "Background color of the boot splash.",
				},
			]),
		);
		assert.ok(html.includes("application/boot_splash/bg_color"), "the property name is rendered");
		assert.ok(html.includes("Background color of the boot splash."), "its documentation is rendered");
		assert.ok(html.includes('id="property-application/boot_splash/bg_color"'), "its anchor is addressable");
	});

	it("does not request focus without a target", () => {
		const html = make_html_content(webview, classSymbol([]));
		assert.ok(!html.includes('ngdtFocus("'));
	});
});

/** Renders only the documentation paragraph of a single method. */
function render_documentation(bbcode: string): string {
	const html = make_symbol_document(
		classSymbol([
			{ name: "abs", kind: SymbolKind.Method, detail: "abs(x: float) -> float", documentation: bbcode },
		]),
	);
	const start = html.indexOf("Method Descriptions");
	const paragraph = /<p >([\s\S]*?)<\/p>/.exec(html.slice(start));
	assert.ok(paragraph, "the method documentation paragraph is rendered");
	return paragraph[1];
}

describe("documentation bbcode", () => {
	it("renders [br] as a line break", () => {
		const html = render_documentation("Line one[br]Line two");
		assert.ok(html.includes("Line one<br/>Line two"), "the break survives as markup");
		assert.ok(!html.includes("inspect('br')"), "the tag is not rewritten into a symbol link");
	});

	it("renders consecutive [br] tags as consecutive breaks", () => {
		const html = render_documentation("A[br][br]B");
		assert.ok(html.includes("A<br/><br/>B"), "each break is emitted");
		assert.ok(!html.includes("inspect('br')"), "no break becomes a symbol link");
	});

	it("renders [kbd] as keyboard markup", () => {
		const html = render_documentation("Press [kbd]Ctrl + A[/kbd] now");
		assert.ok(html.includes("Press <kbd>Ctrl + A</kbd> now"), "the key binding is wrapped");
		assert.ok(!html.includes("[/kbd]"), "the closing tag does not leak as text");
		assert.ok(!html.includes("inspect('kbd')"), "the opening tag is not rewritten into a link");
	});

	it("renders [lb] and [rb] as escaped brackets", () => {
		const html = render_documentation("Write [lb]literal[rb] here");
		assert.ok(html.includes("Write &#91;literal&#93; here"), "both brackets become entities");
		assert.ok(!html.includes("inspect('b')"), "the bracket payload is not read as a tag");
	});

	it("keeps inline code content literal", () => {
		const html = render_documentation("Value [code]Array[int][/code] stays");
		assert.ok(html.includes("<code>Array[int]</code>"), "the indexed type is not rewritten");
		assert.ok(!html.includes("inspect('int')"), "the type argument is not turned into a link");
	});

	it("does not rewrite negative indices inside inline code", () => {
		const html = render_documentation("Index [code]array[-1][/code] stays");
		assert.ok(html.includes("<code>array[-1]</code>"), "the negative index is preserved");
		assert.ok(!html.includes("inspect('1')"), "the index is not turned into a link");
	});

	it("still links class references outside inline code", () => {
		const html = render_documentation("See [Node2D] and [code]Array[int][/code]");
		assert.ok(html.includes(`inspect('Node2D')`), "plain references keep becoming links");
		assert.ok(html.includes("<code>Array[int]</code>"), "inline code stays literal next to a link");
	});
});
