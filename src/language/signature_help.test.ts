import { strict as assert } from "node:assert";
import { describe, it } from "node:test";
import * as vscode from "vscode";
import { DefinitionFallback } from "../fallback/definition.js";
import { ReferencesFallback } from "../fallback/references.js";
import { RenameFallback } from "../fallback/rename.js";
import { LanguageService } from "./service.js";

const URI = "file:///project/main.gd";
const SOURCE = `func method1(a: Array, b: bool, c: int) -> void:
	pass

func method2(values: Dictionary, flag: bool, count: int) -> void:
	pass

func method3(text: String, flag: bool, count: int) -> void:
	pass

func method4(first: int, second: int, third: int) -> void:
	pass

func method5(text: String, flag: bool, count: int) -> void:
	pass

func outer(values: Array, flag: bool) -> void:
	pass

func inner(first: int, second: int) -> void:
	pass

class SignatureOwner:
	func pick(alpha: int, beta: int) -> void:
		pass

	func invoke() -> void:
		pick(inner(1, 2), )

class OtherOwner:
	func pick(gamma: String) -> void:
		pass

func run() -> void:
	method1([1, 2, 3], true, 0)
	method2({"first": 1, "second": 2}, true, 0)
	method3("first, second", true, 0)
	method4(1, # user's value
		2, 3)
	method5("""text " here""", true, 0)
	outer(inner(1, ), true)
	outer(inner(1, 2), )
	outer (inner(1, 2), true)
	method4(method4(1, 2, 3), 4, )
	method3("close ) here", )
	method4(1, # close ) here
		2, )
	method3("""first
second)""", true, )
	method3("open (", true, )
	method4(1, # open ( here
		2, )
	method3("""open (
text""", true, )
	return outer(inner(1, 2), )
`;

function createService(): LanguageService {
	const service = new LanguageService(new DefinitionFallback(), new ReferencesFallback(), new RenameFallback());
	service.files.update(URI, SOURCE, 1);
	service.dependencies.update(URI);
	service.symbols.update(URI);
	service.references.update(URI);
	service.bindings.update(URI);
	service.types.invalidate([URI]);
	service.semantic.invalidate([URI]);
	return service;
}

function documentFor(source: string): vscode.TextDocument {
	const positionAt = (offset: number): vscode.Position => {
		const before = source.slice(0, offset);
		const lineBreak = before.lastIndexOf("\n");
		return new vscode.Position((before.match(/\n/g) ?? []).length, offset - (lineBreak + 1));
	};
	const offsetAt = (position: vscode.Position): number => {
		let offset = 0;
		for (let line = 0; line < position.line; line++) offset = source.indexOf("\n", offset) + 1;
		return offset + position.character;
	};
	return {
		uri: vscode.Uri.parse(URI),
		fileName: "/project/main.gd",
		languageId: "gdscript",
		version: 1,
		getText: (range?: vscode.Range) => (range ? source.slice(offsetAt(range.start), offsetAt(range.end)) : source),
		offsetAt,
		positionAt,
	} as unknown as vscode.TextDocument;
}

function signatureHelpAt(service: LanguageService, marker: string): vscode.SignatureHelp | undefined {
	const offset = SOURCE.indexOf(marker) + marker.length;
	const document = documentFor(SOURCE);
	return service.getSignatureHelp(document, document.positionAt(offset));
}

describe("local signature help", () => {
	it("ignores commas inside array arguments", () => {
		const service = createService();
		try {
			const help = signatureHelpAt(service, "[1, 2");
			assert.equal(help?.activeParameter, 0);
			assert.equal(help?.signatures[0]?.label, "method1(a: Array, b: bool, c: int) -> void");
		} finally {
			service.dispose();
		}
	});

	it("ignores commas inside dictionary arguments", () => {
		const service = createService();
		try {
			assert.equal(signatureHelpAt(service, '"first": 1, "second"')?.activeParameter, 0);
		} finally {
			service.dispose();
		}
	});

	it("ignores commas inside string arguments", () => {
		const service = createService();
		try {
			assert.equal(signatureHelpAt(service, '"first, second"')?.activeParameter, 0);
		} finally {
			service.dispose();
		}
	});

	it("still counts top-level separators", () => {
		const service = createService();
		try {
			assert.equal(signatureHelpAt(service, "true")?.activeParameter, 1);
			assert.equal(signatureHelpAt(service, "[1, 2, 3], true, 0")?.activeParameter, 2);
		} finally {
			service.dispose();
		}
	});

	it("keeps apostrophes in line comments out of the string state", () => {
		const service = createService();
		try {
			assert.equal(signatureHelpAt(service, "# user's value\n\t\t2, ")?.activeParameter, 2);
		} finally {
			service.dispose();
		}
	});

	it("treats a triple-quoted string as one argument", () => {
		const service = createService();
		try {
			assert.equal(signatureHelpAt(service, '"""text " here""", ')?.activeParameter, 1);
		} finally {
			service.dispose();
		}
	});

	it("selects the innermost open nested call", () => {
		const service = createService();
		try {
			const help = signatureHelpAt(service, "outer(inner(1, ");
			assert.equal(help?.signatures[0]?.label, "inner(first: int, second: int) -> void");
			assert.equal(help?.activeParameter, 1);
		} finally {
			service.dispose();
		}
	});

	it("keeps the call binding when whitespace precedes the parenthesis", () => {
		const service = createService();
		try {
			const help = signatureHelpAt(service, "outer (inner(1, 2), ");
			assert.equal(help?.signatures[0]?.label, "outer(values: Array, flag: bool) -> void");
			assert.equal(help?.activeParameter, 1);
		} finally {
			service.dispose();
		}
	});

	it("starts a new call name after a keyword", () => {
		const service = createService();
		try {
			const help = signatureHelpAt(service, "return outer(inner(1, 2), ");
			assert.equal(help?.signatures[0]?.label, "outer(values: Array, flag: bool) -> void");
			assert.equal(help?.activeParameter, 1);
		} finally {
			service.dispose();
		}
	});

	it("returns to the enclosing call after a nested call closes", () => {
		const service = createService();
		try {
			const help = signatureHelpAt(service, "outer(inner(1, 2), ");
			assert.equal(help?.signatures[0]?.label, "outer(values: Array, flag: bool) -> void");
			assert.equal(help?.activeParameter, 1);
		} finally {
			service.dispose();
		}
	});

	it("counts arguments after a nested call", () => {
		const service = createService();
		try {
			const help = signatureHelpAt(service, "method4(method4(1, 2, 3), 4, ");
			assert.equal(help?.signatures[0]?.label, "method4(first: int, second: int, third: int) -> void");
			assert.equal(help?.activeParameter, 2);
		} finally {
			service.dispose();
		}
	});

	it("resolves the enclosing call through its exact name offset", () => {
		const service = createService();
		try {
			const help = signatureHelpAt(service, "pick(inner(1, 2), ");
			assert.equal(help?.signatures[0]?.label, "pick(alpha: int, beta: int) -> void");
			assert.equal(help?.activeParameter, 1);
		} finally {
			service.dispose();
		}
	});

	it("ignores parentheses inside string arguments", () => {
		const service = createService();
		try {
			const help = signatureHelpAt(service, '"close ) here", ');
			assert.equal(help?.signatures[0]?.label, "method3(text: String, flag: bool, count: int) -> void");
			assert.equal(help?.activeParameter, 1);
		} finally {
			service.dispose();
		}
	});

	it("ignores parentheses inside line comments", () => {
		const service = createService();
		try {
			const help = signatureHelpAt(service, "# close ) here\n\t\t2, ");
			assert.equal(help?.signatures[0]?.label, "method4(first: int, second: int, third: int) -> void");
			assert.equal(help?.activeParameter, 2);
		} finally {
			service.dispose();
		}
	});

	it("ignores parentheses inside multiline string arguments", () => {
		const service = createService();
		try {
			const help = signatureHelpAt(service, 'second)""", true, ');
			assert.equal(help?.signatures[0]?.label, "method3(text: String, flag: bool, count: int) -> void");
			assert.equal(help?.activeParameter, 2);
		} finally {
			service.dispose();
		}
	});

	it("ignores an unmatched opening parenthesis inside a string", () => {
		const service = createService();
		try {
			const help = signatureHelpAt(service, '"open (", ');
			assert.equal(help?.signatures[0]?.label, "method3(text: String, flag: bool, count: int) -> void");
			assert.equal(help?.activeParameter, 1);
		} finally {
			service.dispose();
		}
	});

	it("ignores an unmatched opening parenthesis inside a comment", () => {
		const service = createService();
		try {
			const help = signatureHelpAt(service, "# open ( here\n\t\t2, ");
			assert.equal(help?.signatures[0]?.label, "method4(first: int, second: int, third: int) -> void");
			assert.equal(help?.activeParameter, 2);
		} finally {
			service.dispose();
		}
	});

	it("ignores an unmatched opening parenthesis inside a multiline string", () => {
		const service = createService();
		try {
			const help = signatureHelpAt(service, 'text""", true, ');
			assert.equal(help?.signatures[0]?.label, "method3(text: String, flag: bool, count: int) -> void");
			assert.equal(help?.activeParameter, 2);
		} finally {
			service.dispose();
		}
	});
});
