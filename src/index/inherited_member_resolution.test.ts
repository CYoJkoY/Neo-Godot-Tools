import { strict as assert } from "node:assert";
import { describe, it } from "node:test";
import { SemanticQueryEngine } from "../language/semantic/query_engine.js";
import { createBindingIndex } from "./bindings.js";
import { createFileIndex } from "./file_index.js";
import { InheritedMemberResolver, createInheritedMemberResolver } from "./inherited_member_resolution.js";
import { createSymbolIndex } from "./symbol_index.js";
import { createTypeResolutionIndex } from "./type_resolution.js";

const BASE_URI = "file:///workspace/base.gd";
const MIDDLE_URI = "file:///workspace/middle.gd";
const CHILD_URI = "file:///workspace/child.gd";
const PLAIN_BASE_URI = "file:///workspace/plain_base.gd";

function createResolver(sources: Record<string, string>): InheritedMemberResolver {
	const files = createFileIndex();
	const symbols = createSymbolIndex(files);
	for (const [uri, source] of Object.entries(sources)) {
		files.update(uri, source);
		symbols.update(uri);
	}
	return createInheritedMemberResolver(files, symbols);
}

function createSemantic(sources: Record<string, string>): SemanticQueryEngine {
	const files = createFileIndex();
	const symbols = createSymbolIndex(files);
	const bindings = createBindingIndex(files);
	for (const [uri, source] of Object.entries(sources)) {
		files.update(uri, source);
		symbols.update(uri);
		bindings.update(uri);
	}
	return new SemanticQueryEngine(files, symbols, bindings, createTypeResolutionIndex(files, symbols, bindings));
}

describe("InheritedMemberResolver", () => {
	it("resolves a method through multiple inheritance levels when the middle class does not override", () => {
		const resolver = createResolver({
			[BASE_URI]: "class_name Base\nfunc testAA():\n\tpass\n",
			[MIDDLE_URI]: "class_name Middle\nextends Base\n",
			[CHILD_URI]: "class_name Child\nextends Middle\nfunc child_method():\n\t.testAA()\n",
		});

		assert.equal(resolver.resolve(CHILD_URI, "testAA")?.uri, BASE_URI);
	});

	it("selects the nearest override instead of stopping at the first parent", () => {
		const resolver = createResolver({
			[BASE_URI]: "class_name Base\nfunc testAA():\n\tpass\n",
			[MIDDLE_URI]: "class_name Middle\nextends Base\nfunc testAA():\n\tpass\n",
			[CHILD_URI]: "class_name Child\nextends Middle\n",
		});

		assert.equal(resolver.resolve(CHILD_URI, "testAA")?.uri, MIDDLE_URI);
	});

	it("resolves a current-class override before inherited definitions", () => {
		const resolver = createResolver({
			[BASE_URI]: "class_name Base\nfunc testAA():\n\tpass\n",
			[MIDDLE_URI]: "class_name Middle\nextends Base\nfunc testAA():\n\tpass\n",
			[CHILD_URI]: "class_name Child\nextends Middle\nfunc testAA():\n\tpass\n",
		});

		assert.equal(resolver.resolve(CHILD_URI, "testAA")?.uri, CHILD_URI);
	});

	it("resolves a function scoped to an inner class without confusing it with top-level functions", () => {
		const resolver = createResolver({
			[CHILD_URI]: "class_name Child\nclass Worker:\n\tfunc run():\n\t\tpass\nfunc run():\n\tpass\n",
		});

		assert.equal(resolver.resolve(CHILD_URI, "run", "Worker")?.range.start.line, 2);
	});
});

describe("SemanticQueryEngine inherited definitions", () => {
	const sources = {
		[BASE_URI]: "class_name Base\nfunc testAA():\n\tpass\n",
		[MIDDLE_URI]: "class_name Middle\nextends Base\n",
		[CHILD_URI]:
			"class_name Child\nextends Middle\nfunc child_method():\n\t.testAA()\n\tself.testAA()\n\tvar object: Child\n\tobject.testAA()\n",
	};

	it("resolves shorthand .foo() calls to the inherited declaration", () => {
		const semantic = createSemantic(sources);
		const source = sources[CHILD_URI];
		const offset = source.indexOf(".testAA()") + 2;
		assert.equal(semantic.getDefinition(CHILD_URI, { offset }).value?.uri, BASE_URI);
	});

	it("resolves explicit self.foo() calls to the inherited declaration", () => {
		const semantic = createSemantic(sources);
		const source = sources[CHILD_URI];
		const offset = source.indexOf("self.testAA") + "self.".length + 1;
		assert.equal(semantic.getDefinition(CHILD_URI, { offset }).value?.uri, BASE_URI);
	});

	it("resolves typed object.foo() calls to the inherited declaration", () => {
		const semantic = createSemantic(sources);
		const source = sources[CHILD_URI];
		const offset = source.indexOf("object.testAA") + "object.".length + 1;
		assert.equal(semantic.getDefinition(CHILD_URI, { offset }).value?.uri, BASE_URI);
	});

	it("uses the intermediate override when it exists", () => {
		const overrideSources = {
			...sources,
			[MIDDLE_URI]: "class_name Middle\nextends Base\nfunc testAA():\n\tpass\n",
		};
		const semantic = createSemantic(overrideSources);
		const source = overrideSources[CHILD_URI];
		const offset = source.indexOf(".testAA()") + 2;
		assert.equal(semantic.getDefinition(CHILD_URI, { offset }).value?.uri, MIDDLE_URI);
	});

	it("skips the current override of a shorthand .foo() call", () => {
		const overrideSources = {
			[BASE_URI]: "class_name Base\nfunc testAA():\n\tpass\n",
			[MIDDLE_URI]: "class_name Middle\nextends Base\nfunc testAA():\n\tpass\n",
			[CHILD_URI]:
				"class_name Child\nextends Middle\nfunc testAA():\n\t.testAA()\n\tpass\n",
		};
		const semantic = createSemantic(overrideSources);
		const source = overrideSources[CHILD_URI];
		const offset = source.indexOf(".testAA()") + 2;
		const definition = semantic.getDefinition(CHILD_URI, { offset });
		assert.equal(definition.confidence, "exact");
		assert.equal(definition.value?.uri, MIDDLE_URI);
		assert.equal(definition.value?.range.start.line, 2);
	});

	it("keeps walking up when the parent does not override the current method", () => {
		const overrideSources = {
			[BASE_URI]: "class_name Base\nfunc testAA():\n\tpass\n",
			[MIDDLE_URI]: "class_name Middle\nextends Base\n",
			[CHILD_URI]:
				"class_name Child\nextends Middle\nfunc testAA():\n\t.testAA()\n\tpass\n",
		};
		const semantic = createSemantic(overrideSources);
		const source = overrideSources[CHILD_URI];
		const offset = source.indexOf(".testAA()") + 2;
		assert.equal(semantic.getDefinition(CHILD_URI, { offset }).value?.uri, BASE_URI);
	});

	it("distinguishes super.foo() from self.foo() inside an override", () => {
		const overrideSources = {
			[BASE_URI]: "class_name Base\nfunc testAA():\n\tpass\n",
			[MIDDLE_URI]: "class_name Middle\nextends Base\nfunc testAA():\n\tpass\n",
			[CHILD_URI]:
				"class_name Child\nextends Middle\nfunc testAA():\n\tsuper.testAA()\n\tself.testAA()\n\tpass\n",
		};
		const semantic = createSemantic(overrideSources);
		const source = overrideSources[CHILD_URI];
		const parentOffset = source.indexOf("super.testAA") + "super.".length + 1;
		const selfOffset = source.indexOf("self.testAA") + "self.".length + 1;
		assert.equal(semantic.getDefinition(CHILD_URI, { offset: parentOffset }).value?.uri, MIDDLE_URI);
		assert.equal(semantic.getDefinition(CHILD_URI, { offset: selfOffset }).value?.uri, CHILD_URI);
	});

	it("resolves a parent script that has no class_name", () => {
		const pathSources = {
			[PLAIN_BASE_URI]: "extends Node\nfunc testAA():\n\tpass\n",
			[CHILD_URI]:
				'extends "res://plain_base.gd"\nfunc testAA():\n\t.testAA()\n\tpass\n',
		};
		const semantic = createSemantic(pathSources);
		const source = pathSources[CHILD_URI];
		const offset = source.indexOf(".testAA()") + 2;
		const definition = semantic.getDefinition(CHILD_URI, { offset });
		assert.equal(definition.confidence, "exact");
		assert.equal(definition.value?.uri, PLAIN_BASE_URI);
		assert.equal(definition.value?.name, "testAA");
	});

	it("resolves Ctrl+Click on a method of a GDScript inner class", () => {
		const innerSources = {
			[CHILD_URI]:
				"class_name Child\nclass Worker:\n\tfunc run():\n\t\tpass\nfunc use_worker():\n\tWorker.run()\n",
		};
		const semantic = createSemantic(innerSources);
		const source = innerSources[CHILD_URI];
		const offset = source.indexOf("Worker.run") + "Worker.".length + 1;
		const definition = semantic.getDefinition(CHILD_URI, { offset });
		assert.equal(definition.confidence, "exact");
		assert.equal(definition.value?.name, "run");
		assert.equal(definition.value?.containerName, "Worker");
	});
});
