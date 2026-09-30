import { strict as assert } from "node:assert";
import { describe, it } from "node:test";
import type { GodotNativeSymbol } from "./documentation_types.js";
import { DOC_FOCUS_FUNCTION, make_html_content, make_symbol_document } from "./documentation_builder.js";

/** vscode `SymbolKind` values, mirrored from the language-client enum. */
const SymbolKind = { Class: 4, Method: 5, Property: 6, Constructor: 8, Enum: 9, Function: 11, Variable: 12, Constant: 13, EnumMember: 21, Event: 23, Operator: 24 } as const;

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
		const html = make_symbol_document(classSymbol([
			{ name: "abs", kind: SymbolKind.Method, detail: "abs(x: float) -> float", documentation: "" },
			{ name: "anchor_left", kind: SymbolKind.Property, detail: "var Control.anchor_left: float", documentation: "" },
			{ name: "FOCUS_ALL", kind: SymbolKind.Constant, detail: "const Control.FOCUS_ALL: FocusMode = 2", documentation: "" },
			{ name: "changed", kind: SymbolKind.Event, detail: "signal Control.changed()", documentation: "" },
			{ name: "_init", kind: SymbolKind.Constructor, detail: "_init()", documentation: "" },
		]));
		assert.ok(html.includes('id="method-abs"'), "methods use the `method-` anchor prefix");
		assert.ok(html.includes('id="property-anchor_left"'));
		assert.ok(html.includes('id="constant-focus_all"'));
		assert.ok(html.includes('id="signal-changed"'));
		assert.ok(html.includes('id="constructor-_init"'));
		assert.ok(!html.includes('id="abs"'), "plain symbol names are no longer used as ids");
	});

	it("links the index to the same anchor used for navigation", () => {
		const html = make_symbol_document(classSymbol([
			{ name: "abs", kind: SymbolKind.Method, detail: "abs(x: float) -> float", documentation: "" },
		]));
		assert.ok(html.includes('href="#method-abs"'));
	});

	it("keeps name based lookups working through data attributes", () => {
		const html = make_symbol_document(classSymbol([
			{ name: "anchor_left", kind: SymbolKind.Property, detail: "var Control.anchor_left: float", documentation: "" },
		]));
		assert.ok(html.includes('data-symbol="anchor_left"'));
	});

	it("focuses the exact section of a builtin function", () => {
		const html = make_html_content(webview, classSymbol([
			{ name: "abs", kind: SymbolKind.Method, detail: "abs(x: float) -> float", documentation: "" },
			{ name: "sign", kind: SymbolKind.Method, detail: "sign(x: float) -> float", documentation: "" },
		]), "method-abs");
		assert.ok(html.includes(DOC_FOCUS_FUNCTION.slice(0, 40)));
		assert.ok(html.includes('ngdtFocus("method-abs")'), "the page focuses the requested anchor on load");
		assert.ok(html.includes('document.getElementById(ids[i])'), "the resolver can fall back to candidate ids");
	});

	it("does not request focus without a target", () => {
		const html = make_html_content(webview, classSymbol([]));
		assert.ok(!html.includes('ngdtFocus("'));
	});
});
