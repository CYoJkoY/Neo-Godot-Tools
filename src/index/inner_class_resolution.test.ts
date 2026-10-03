import { strict as assert } from "node:assert";
import { describe, it } from "node:test";
import { parseGDScript } from "../analyzer/index.js";
import { BindingIndex } from "./bindings.js";
import { FileIndex } from "./file_index.js";
import { SymbolIndex } from "./symbol_index.js";
import { TypeResolutionIndex } from "./type_resolution.js";
import { SemanticQueryEngine } from "../language/semantic/query_engine.js";

const URI = "file:///workspace/inner.gd";

function index(source: string, extra: Record<string, string> = {}) {
	const files = new FileIndex();
	const symbols = new SymbolIndex(files);
	const bindings = new BindingIndex(files);
	for (const [uri, text] of Object.entries({ [URI]: source, ...extra })) {
		files.update(uri, text, 1);
		symbols.update(uri);
		bindings.update(uri);
	}
	const types = new TypeResolutionIndex(files, symbols, bindings);
	return { files, symbols, bindings, types, semantic: new SemanticQueryEngine(files, symbols, bindings, types) };
}

function definitionAt(source: string, marker: string, offsetInMarker = marker.length - 1, extra: Record<string, string> = {}) {
	const { semantic } = index(source, extra);
	const start = source.indexOf(marker);
	assert.ok(start >= 0, `marker ${marker} not found`);
	return semantic.getDefinition(URI, { offset: start + offsetInMarker });
}

function completionsAt(source: string, marker: string, offsetInMarker = marker.length) {
	const { semantic } = index(source);
	const start = source.lastIndexOf(marker);
	assert.ok(start >= 0, `marker ${marker} not found`);
	return semantic.getCompletions(URI, { offset: start + offsetInMarker });
}

describe("inner class parsing", () => {
	it("keeps the body of a class that extends another class", () => {
		const result = parseGDScript("class_name C\nclass Worker extends Base:\n\tfunc run():\n\t\tpass\n");
		const inner = result.ast.declarations.find((declaration) => declaration.kind === "class");
		assert.ok(inner && inner.kind === "class");
		assert.equal(inner.extendsName, "Base", "the declaration colon must not be part of the base name");
		assert.deepEqual(inner.declarations.map((declaration) => declaration.name), ["run"]);
	});

	it("does not leak function locals into the class member list", () => {
		const source = "class_name C\nvar speed := 1\nfunc run():\n\tvar local_speed := speed\n\tvar helper := Worker.new()\n\treturn local_speed\nclass Worker:\n\tfunc go():\n\t\tvar inner_local := 1\n";
		const { files, types } = index(source);
		const names = files.get(URI)!.symbols.map((symbol) => symbol.name);
		assert.equal(names.includes("local_speed"), false, "a local variable is not a script member");
		assert.equal(names.includes("helper"), false, "a local variable is not a script member");
		assert.equal(names.includes("inner_local"), false, "a local variable is not a class member");
		assert.deepEqual(types.getMembers(types.resolveName("Worker")!).map((symbol) => symbol.name), ["go"]);
	});

	it("records the owning class of every nested declaration", () => {
		const source = "class_name C\nclass Worker:\n\tvar speed := 1\n\tfunc run():\n\t\tpass\nclass Outer:\n\tclass Inner:\n\t\tfunc deep():\n\t\t\tpass\n";
		const { files } = index(source);
		const symbols = files.get(URI)!.symbols;
		const worker = symbols.find((symbol) => symbol.name === "Worker")!;
		const run = symbols.find((symbol) => symbol.name === "run")!;
		const inner = symbols.find((symbol) => symbol.name === "Inner")!;
		const deep = symbols.find((symbol) => symbol.name === "deep")!;
		assert.equal(run.containerName, "Worker");
		assert.equal(run.containerRange?.start.offset, worker.range.start.offset);
		assert.equal(inner.containerName, "Outer");
		assert.equal(deep.containerName, "Inner");
		assert.equal(deep.containerRange?.start.offset, inner.range.start.offset);
	});
});

describe("inner class member resolution", () => {
	const INNER_SOURCE = `class_name Child
class Worker:
	var speed := 1
	func run() -> int:
		return speed
	func helper():
		self.run()
		var worker := Worker.new()
		worker.run()
func use_worker():
	Worker.run()
	Worker.new().run()
`;

	it("lists own members for a class instead of the class symbol", () => {
		const { types } = index(INNER_SOURCE);
		const worker = types.resolveName("Worker")!;
		assert.deepEqual(
			types.getMembers(worker).map((symbol) => symbol.name).sort(),
			["helper", "run", "speed"],
		);
	});

	it("resolves self.member inside an inner class", () => {
		const result = definitionAt(INNER_SOURCE, "self.run", "self.run".length - 1);
		assert.equal(result.confidence, "exact");
		assert.equal(result.value?.name, "run");
		assert.equal(result.value?.containerName, "Worker");
	});

	it("resolves class-qualified calls and instances created from the class", () => {
		const qualified = definitionAt(INNER_SOURCE, "Worker.run", "Worker.run".length - 1);
		assert.equal(qualified.value?.name, "run");
		const chained = definitionAt(INNER_SOURCE, "Worker.new().run", "Worker.new().run".length - 1);
		assert.equal(chained.value?.name, "run");
		const variable = definitionAt(INNER_SOURCE, "worker.run", "worker.run".length - 1);
		assert.equal(variable.value?.name, "run");
	});

	it("keeps identically named members of different inner classes apart", () => {
		const source = `class_name Child
class Alpha:
	func run():
		pass
class Beta:
	func run():
		pass
func use_alpha():
	self.alpha.run()
	Alpha.run()
func use_beta():
	Beta.run()
`;
		const alpha = definitionAt(source, "Alpha.run", "Alpha.run".length - 1);
		assert.equal(alpha.value?.range.start.line, 2);
		const beta = definitionAt(source, "Beta.run", "Beta.run".length - 1);
		assert.equal(beta.value?.range.start.line, 5);
	});

	it("follows inheritance between inner classes", () => {
		const source = `class_name Child
class Base:
	func base_fn() -> int:
		return 1
class Worker extends Base:
	func run():
		self.base_fn()
`;
		const result = definitionAt(source, "self.base_fn", "self.base_fn".length - 1);
		assert.equal(result.confidence, "exact");
		assert.equal(result.value?.name, "base_fn");
		assert.equal(result.value?.containerName, "Base");
	});

	it("resolves super calls inside an inner class to the inner base class", () => {
		const source = `class_name Child
class Base:
	func ping():
		pass
class Worker extends Base:
	func ping():
		super.ping()
`;
		const result = definitionAt(source, "super.ping", "super.ping".length - 1);
		assert.equal(result.value?.containerName, "Base");
	});

	it("resolves members of nested classes through self", () => {
		const source = `class_name Child
class A:
	class B:
		func deep():
			pass
	func call():
		self.B.deep()
`;
		const result = definitionAt(source, "self.B.deep", "self.B.deep".length - 1);
		assert.equal(result.value?.name, "deep");
		assert.equal(result.value?.containerName, "B");
	});

	it("resolves enum members declared inside an inner class", () => {
		const source = `class_name Child
class Worker:
	enum Mode { IDLE, BUSY }
	func run():
		self.Mode
`;
		const result = definitionAt(source, "self.Mode", "self.Mode".length - 1);
		assert.equal(result.value?.kind, "enum");
		assert.equal(result.value?.containerName, "Worker");
	});
});

describe("inner class completions", () => {
	it("completes class members after a class name and after self", () => {
		const qualified = completionsAt("class_name Child\nclass Worker:\n\tvar speed := 1\n\tfunc run():\n\t\tpass\nfunc use():\n\tWorker.\n", "Worker.");
		assert.deepEqual(qualified.value?.map((item) => item.name).sort(), ["run", "speed"]);

		const self = completionsAt("class_name Child\nclass Worker:\n\tvar speed := 1\n\tfunc run():\n\t\tself.\n", "self.");
		assert.deepEqual(self.value?.map((item) => item.name).sort(), ["run", "speed"]);
	});
});

describe("inner class references", () => {
	it("binds qualified, self and instance calls to one declaration", () => {
		const source = `class_name Child
class Worker:
	func run():
		pass
	func helper():
		self.run()
func use_worker():
	var worker := Worker.new()
	worker.run()
	Worker.run()
`;
		const { bindings, files } = index(source);
		const declaration = bindings.getBinding(URI, source.indexOf("func run") + "func ".length, "run");
		assert.ok(declaration, "the inner class method must be a binding");
		const lines = bindings
			.findReferences(declaration.id)
			.map((reference) => reference.range.start.line)
			.sort((left, right) => left - right);
		assert.deepEqual(lines, [2, 5, 8, 9], "every call form must reference the declaration");
		assert.equal(files.get(URI)?.symbols.filter((symbol) => symbol.name === "run").length, 1);
	});
});

describe("nested class navigation through expressions", () => {
	it("resolves a qualified type annotation to the nested class", () => {
		const source = `class_name Child
class Outer:
	class Inner:
		var speed := 1
func use():
	var item: Outer.Inner = null
	item.speed
`;
		const annotation = definitionAt(source, "Outer.Inner", "Outer.Inner".length - 1);
		assert.equal(annotation.value?.name, "Inner");
		assert.equal(annotation.value?.kind, "class");

		const member = definitionAt(source, "item.speed", "item.speed".length - 1);
		assert.equal(member.confidence, "exact");
		assert.equal(member.value?.name, "speed");
	});

	it("resolves a qualified annotation that points into another script", () => {
		const source = `extends Node
func use():
	var item: Outer.Inner = null
	item.inner_fn()
`;
		const extra = {
			"file:///workspace/outer.gd": "class_name Outer\nclass Inner:\n\tfunc inner_fn():\n\t\tpass\n",
		};
		const member = definitionAt(source, "item.inner_fn", "item.inner_fn".length - 1, extra);
		assert.equal(member.confidence, "exact");
		assert.equal(member.value?.name, "inner_fn");
		assert.equal(member.value?.containerName, "Inner");
	});

	it("keeps chained constructions of same-named methods apart", () => {
		const source = `class_name Child
class Alpha:
	func run():
		pass
class Beta:
	func run():
		pass
func use():
	Alpha.new().run()
	Beta.new().run()
`;
		const alpha = definitionAt(source, "Alpha.new().run", "Alpha.new().run".length - 1);
		assert.equal(alpha.value?.containerName, "Alpha");
		const beta = definitionAt(source, "Beta.new().run", "Beta.new().run".length - 1);
		assert.equal(beta.value?.containerName, "Beta");
	});

	it("resolves a method called on the result of another method", () => {
		const source = `class_name Child
class Worker:
	func run():
		pass
static func make() -> Worker:
	return Worker.new()
func use():
	self.make().run()
	self.make().run()
`;
		const result = definitionAt(source, "self.make().run", "self.make().run".length - 1);
		assert.equal(result.confidence, "exact");
		assert.equal(result.value?.name, "run");
		assert.equal(result.value?.containerName, "Worker");
	});

	it("follows a nested class base declared as a qualified name", () => {
		const source = `class_name Child
class Outer:
	class Base:
		func deep():
			pass
	class Worker extends Outer.Base:
		func run():
			self.deep()
`;
		const result = definitionAt(source, "self.deep", "self.deep".length - 1);
		assert.equal(result.value?.name, "deep");
		assert.equal(result.value?.containerName, "Base");
	});

	it("inherits nested class members from a class_name base in another script", () => {
		const source = `class_name Outer
class Inner extends Base:
	func inner_fn():
		self.base_fn()
`;
		const extra = { "file:///workspace/base.gd": "class_name Base\nfunc base_fn() -> int:\n\treturn 1\n" };
		const result = definitionAt(source, "self.base_fn", "self.base_fn".length - 1, extra);
		assert.equal(result.confidence, "exact");
		assert.equal(result.value?.name, "base_fn");
		assert.equal(result.value?.uri, "file:///workspace/base.gd");
	});

	it("resolves a chained call on an inherited nested class member", () => {
		const userSource = "extends Node\nfunc use():\n\tOuter.Inner.new().base_fn()\n";
		const extra = {
			"file:///workspace/base.gd": "class_name Base\nfunc base_fn() -> int:\n\treturn 1\n",
			"file:///workspace/outer.gd": "class_name Outer\nclass Inner extends Base:\n\tfunc inner_fn():\n\t\tpass\n",
		};
		const files = new FileIndex();
		const symbols = new SymbolIndex(files);
		const bindings = new BindingIndex(files);
		for (const [uri, text] of Object.entries({ [URI]: userSource, ...extra })) {
			files.update(uri, text, 1);
			symbols.update(uri);
			bindings.update(uri);
		}
		const types = new TypeResolutionIndex(files, symbols, bindings);
		const semantic = new SemanticQueryEngine(files, symbols, bindings, types);
		const offset = userSource.indexOf("Outer.Inner.new().base_fn") + "Outer.Inner.new().base_fn".length - 1;
		const result = semantic.getDefinition(URI, { offset });
		assert.equal(result.confidence, "exact");
		assert.equal(result.value?.name, "base_fn");
		assert.equal(result.value?.uri, "file:///workspace/base.gd");
	});

	it("binds a super call of a nested class to its own base", () => {
		const source = `class_name Child
class Base:
	func ping():
		pass
class Worker extends Base:
	func ping():
		super.ping()
`;
		const { bindings } = index(source);
		const baseDeclaration = bindings.getBinding(URI, source.indexOf("func ping"), "ping");
		assert.ok(baseDeclaration);
		assert.deepEqual(
			bindings.findReferences(baseDeclaration.id).map((reference) => reference.range.start.line).sort((a, b) => a - b),
			[2, 6],
			"the base declaration and the super call must share one binding",
		);

		const override = bindings.getBinding(URI, source.lastIndexOf("func ping"), "ping");
		assert.ok(override);
		assert.notEqual(override.id, baseDeclaration.id, "an override is its own declaration");
	});

	it("navigates static inner methods, casts and deep nesting", () => {
		const source = `class_name Child
class Outer:
	class Inner:
		class Deep:
			func fn():
				pass
		var slot := "s"
	var inner := Inner.new()

func use(node) -> void:
	var built := Outer.Inner.Deep.new()
	built.fn()
	var typed: Outer.Inner = Outer.Inner.new()
	typed.slot
	if node is Outer.Inner.Deep:
		pass

static func create() -> Outer.Inner:
	return Outer.Inner.new()
`;
		const { semantic } = index(source);
		// [marker around the click, word to click, expected symbol]
		const cases: Array<[string, string, string, string]> = [
			["var built := Outer.Inner.Deep.new()", "Deep", "Deep", "class"],
			["built.fn()", "fn", "fn", "function"],
			["var typed: Outer.Inner = Outer.Inner.new()", "Inner", "Inner", "class"],
			["typed.slot", "slot", "slot", "variable"],
			["if node is Outer.Inner.Deep:", "Deep", "Deep", "class"],
			["static func create() -> Outer.Inner:", "Inner", "Inner", "class"],
		];
		for (const [marker, word, name, kind] of cases) {
			const start = source.lastIndexOf(marker);
			assert.ok(start >= 0, `marker ${marker} not found`);
			const offset = start + marker.lastIndexOf(word) + Math.floor(word.length / 2);
			const result = semantic.getDefinition(URI, { offset });
			assert.equal(result.confidence, "exact", `${marker} must resolve`);
			assert.equal(result.value?.name, name, `${marker} must reach ${name}`);
			assert.equal(result.value?.kind, kind, `${marker} must reach a ${kind}`);
		}
	});

	it("navigates members of an inner class reached through a static factory", () => {
		const other = `class_name Inventory
class Item:
	var id := 0
	func describe() -> String:
		return "n/a"

static func create() -> Inventory:
	return Inventory.new()

func items() -> Array:
	return []
`;
		const source = `class_name Player
var inventory := Inventory.create()

func use() -> void:
	inventory.items()
	Inventory.create().items()
	inventory.items().size()
`;
		const { semantic } = index(source, { "file:///workspace/inventory.gd": other });
		for (const marker of ["inventory.items()", "Inventory.create().items()", "inventory.items().size()"]) {
			const start = source.lastIndexOf(marker);
			assert.ok(start >= 0, `marker ${marker} not found`);
			const offset = start + marker.lastIndexOf("items") + 2;
			const result = semantic.getDefinition(URI, { offset });
			assert.equal(result.confidence, "exact", `${marker} must resolve`);
			assert.equal(result.value?.name, "items", `${marker} must reach items`);
			assert.equal(result.value?.uri, "file:///workspace/inventory.gd");
		}
	});

	it("binds overridden and inherited calls to the right declaration", () => {
		const source = `class_name Child
class Base:
	func ping():
		pass
class Worker extends Base:
	func run():
		self.ping()
	func ping():
		super.ping()
`;
		const { bindings } = index(source);
		const base = bindings.getBinding(URI, source.indexOf("func ping"), "ping");
		const override = bindings.getBinding(URI, source.lastIndexOf("func ping"), "ping");
		assert.ok(base && override);
		assert.notEqual(base.id, override.id, "an override declares its own member");
		const lines = (binding: { id: string }) => bindings.findReferences(binding.id).map((reference) => reference.range.start.line + 1).sort((a, b) => a - b);
		assert.deepEqual(lines(base), [3, 9], "the base and its super call share one binding");
		assert.deepEqual(lines(override), [7, 8], "self.ping reaches the override, not the base");
	});

	it("completes members after a chained construction", () => {
		const source = "class_name Child\nclass Worker:\n\tvar speed := 1\n\tfunc run():\n\t\tpass\nfunc use():\n\tWorker.new().\n";
		const result = completionsAt(source, "Worker.new().", "Worker.new().".length);
		assert.equal(result.confidence, "exact");
		assert.deepEqual(result.value?.map((item) => item.name).sort(), ["run", "speed"]);
	});
});
