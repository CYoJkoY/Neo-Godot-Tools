import { expect, describe, it } from "vitest";
import { BindingIndex } from "./bindings.js";
import { FileIndex } from "./file_index.js";
import { InheritedMemberResolver } from "./inherited_member_resolution.js";
import { SymbolIndex } from "./symbol_index.js";
import { TypeResolutionIndex } from "./type_resolution.js";
import { SemanticQueryEngine } from "../language/semantic/query_engine.js";

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

function createSemantic(sources: Record<string, string>): SemanticQueryEngine {
	const files = new FileIndex();
	const symbols = new SymbolIndex(files);
	const bindings = new BindingIndex(files);
	for (const [uri, source] of Object.entries(sources)) {
		files.update(uri, source);
		symbols.update(uri);
		bindings.update(uri);
	}
	return new SemanticQueryEngine(files, symbols, bindings, new TypeResolutionIndex(files, symbols, bindings));
}

describe("InheritedMemberResolver", () => {
	it("resolves a method through multiple inheritance levels when the middle class does not override", () => {
		const resolver = createResolver({
			[BASE_URI]: "class_name Base\nfunc testAA():\n\tpass\n",
			[MIDDLE_URI]: "class_name Middle\nextends Base\n",
			[CHILD_URI]: "class_name Child\nextends Middle\nfunc child_method():\n\t.testAA()\n",
		});

		expect(resolver.resolve(CHILD_URI, "testAA")?.uri).toBe(BASE_URI);
	});

	it("selects the nearest override instead of stopping at the first parent", () => {
		const resolver = createResolver({
			[BASE_URI]: "class_name Base\nfunc testAA():\n\tpass\n",
			[MIDDLE_URI]: "class_name Middle\nextends Base\nfunc testAA():\n\tpass\n",
			[CHILD_URI]: "class_name Child\nextends Middle\n",
		});

		expect(resolver.resolve(CHILD_URI, "testAA")?.uri).toBe(MIDDLE_URI);
	});

	it("resolves a current-class override before inherited definitions", () => {
		const resolver = createResolver({
			[BASE_URI]: "class_name Base\nfunc testAA():\n\tpass\n",
			[MIDDLE_URI]: "class_name Middle\nextends Base\nfunc testAA():\n\tpass\n",
			[CHILD_URI]: "class_name Child\nextends Middle\nfunc testAA():\n\tpass\n",
		});

		expect(resolver.resolve(CHILD_URI, "testAA")?.uri).toBe(CHILD_URI);
	});
});

describe("SemanticQueryEngine inherited definitions", () => {
	const sources = {
		[BASE_URI]: "class_name Base\nfunc testAA():\n\tpass\n",
		[MIDDLE_URI]: "class_name Middle\nextends Base\n",
		[CHILD_URI]: "class_name Child\nextends Middle\nfunc child_method():\n\t.testAA()\n\tself.testAA()\n\tvar object: Child\n\tobject.testAA()\n",
	};

	it("resolves shorthand .foo() calls to the inherited declaration", () => {
		const semantic = createSemantic(sources);
		const source = sources[CHILD_URI];
		const offset = source.indexOf(".testAA()") + 2;
		expect(semantic.getDefinition(CHILD_URI, { offset }).value?.uri).toBe(BASE_URI);
	});

	it("resolves explicit self.foo() calls to the inherited declaration", () => {
		const semantic = createSemantic(sources);
		const source = sources[CHILD_URI];
		const offset = source.indexOf("self.testAA") + "self.".length + 1;
		expect(semantic.getDefinition(CHILD_URI, { offset }).value?.uri).toBe(BASE_URI);
	});

	it("resolves typed object.foo() calls to the inherited declaration", () => {
		const semantic = createSemantic(sources);
		const source = sources[CHILD_URI];
		const offset = source.indexOf("object.testAA") + "object.".length + 1;
		expect(semantic.getDefinition(CHILD_URI, { offset }).value?.uri).toBe(BASE_URI);
	});

	it("uses the intermediate override when it exists", () => {
		const overrideSources = {
			...sources,
			[MIDDLE_URI]: "class_name Middle\nextends Base\nfunc testAA():\n\tpass\n",
		};
		const semantic = createSemantic(overrideSources);
		const source = overrideSources[CHILD_URI];
		const offset = source.indexOf(".testAA()") + 2;
		expect(semantic.getDefinition(CHILD_URI, { offset }).value?.uri).toBe(MIDDLE_URI);
	});
});
