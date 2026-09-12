import * as assert from "node:assert";
import { test } from "node:test";
import { BindingIndex } from "./bindings.js";
import { FileIndex } from "./file_index.js";
import { InheritedMemberResolver } from "./inherited_member_resolution.js";
import { SymbolIndex } from "./symbol_index.js";

const BASE_URI = "file:///workspace/base.gd";
const MIDDLE_URI = "file:///workspace/middle.gd";
const CHILD_URI = "file:///workspace/child.gd";

function createResolver(sources: Record<string, string>): InheritedMemberResolver {
	const files = new FileIndex();
	const symbols = new SymbolIndex(files);
	for (const [uri, source] of Object.entries(sources)) {
		files.update(uri, source);
		symbols.update(uri);
	}
	return new InheritedMemberResolver(files, symbols);
}

function createSemanticFixture(sources: Record<string, string>) {
	const files = new FileIndex();
	const symbols = new SymbolIndex(files);
	const bindings = new BindingIndex(files);
	for (const [uri, source] of Object.entries(sources)) {
		files.update(uri, source);
		symbols.update(uri);
		bindings.update(uri);
	}
	return { files, symbols, bindings };
}

test("resolves a method through multiple inheritance levels when middle class does not override", () => {
	const resolver = createResolver({
		[BASE_URI]: "class_name Base\nfunc testAA():\n\tpass\n",
		[MIDDLE_URI]: "class_name Middle\nextends Base\n",
		[CHILD_URI]: "class_name Child\nextends Middle\nfunc child_method():\n\ttestAA()\n",
	});

	const symbol = resolver.resolve(CHILD_URI, "testAA");
	assert.equal(symbol?.uri, BASE_URI);
});

test("selects the nearest override instead of stopping at the first parent", () => {
	const resolver = createResolver({
		[BASE_URI]: "class_name Base\nfunc testAA():\n\tpass\n",
		[MIDDLE_URI]: "class_name Middle\nextends Base\nfunc testAA():\n\tpass\n",
		[CHILD_URI]: "class_name Child\nextends Middle\n",
	});

	const symbol = resolver.resolve(CHILD_URI, "testAA");
	assert.equal(symbol?.uri, MIDDLE_URI);
});

test("resolves current-class override before inherited definitions", () => {
	const resolver = createResolver({
		[BASE_URI]: "class_name Base\nfunc testAA():\n\tpass\n",
		[MIDDLE_URI]: "class_name Middle\nextends Base\nfunc testAA():\n\tpass\n",
		[CHILD_URI]: "class_name Child\nextends Middle\nfunc testAA():\n\tpass\n",
	});

	const symbol = resolver.resolve(CHILD_URI, "testAA");
	assert.equal(symbol?.uri, CHILD_URI);
});

test("semantic definition resolves shorthand self calls to the inherited declaration", () => {
	const source = "class_name Child\nextends Middle\nfunc child_method():\n\ttestAA()\n\tself.testAA()\n";
	const { files, symbols, bindings } = createSemanticFixture({
		[BASE_URI]: "class_name Base\nfunc testAA():\n\tpass\n",
		[MIDDLE_URI]: "class_name Middle\nextends Base\n",
		[CHILD_URI]: source,
	});
	const types = new (require("./type_resolution.js").TypeResolutionIndex)(files, symbols, bindings);
	const { SemanticQueryEngine } = require("../language/semantic/query_engine.js");
	const semantic = new SemanticQueryEngine(files, symbols, bindings, types);

	for (const marker of ["testAA()", "self.testAA()"] as const) {
		const offset = source.indexOf(marker) + marker.indexOf("testAA");
		const result = semantic.getDefinition(CHILD_URI, { offset });
		assert.equal(result.value?.uri, BASE_URI);
	}
});

test("semantic definition resolves an explicitly typed object through its inheritance chain", () => {
	const source = "class_name Child\nextends Middle\nfunc child_method():\n\tvar object: Child\n\tobject.testAA()\n";
	const { files, symbols, bindings } = createSemanticFixture({
		[BASE_URI]: "class_name Base\nfunc testAA():\n\tpass\n",
		[MIDDLE_URI]: "class_name Middle\nextends Base\n",
		[CHILD_URI]: source,
	});
	const types = new (require("./type_resolution.js").TypeResolutionIndex)(files, symbols, bindings);
	const { SemanticQueryEngine } = require("../language/semantic/query_engine.js");
	const semantic = new SemanticQueryEngine(files, symbols, bindings, types);
	const offset = source.indexOf("object.testAA") + "object.".length;
	const result = semantic.getDefinition(CHILD_URI, { offset });
	assert.equal(result.value?.uri, BASE_URI);
});
