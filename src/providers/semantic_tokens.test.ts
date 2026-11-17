import { strict as assert } from "node:assert";
import { describe, it } from "node:test";
import * as vscode from "vscode";
import { DefinitionFallback } from "../fallback/definition.js";
import { ReferencesFallback } from "../fallback/references.js";
import { RenameFallback } from "../fallback/rename.js";
import { LanguageService } from "../language/service.js";
import { collectSemanticTokens, type SemanticToken } from "./semantic_tokens.js";

function fakeDocument(file: string, source: string, languageId = "gdscript"): vscode.TextDocument {
	const lineStarts = [0];
	for (let index = 0; index < source.length; index++) if (source[index] === "\n") lineStarts.push(index + 1);
	const positionAt = (offset: number): vscode.Position => {
		const line = lineStarts.reduce((found, start, index) => (start <= offset ? index : found), 0);
		return new vscode.Position(line, offset - lineStarts[line]);
	};
	const offsetAt = (position: vscode.Position): number => lineStarts[position.line] + position.character;
	return {
		uri: vscode.Uri.file(file),
		fileName: file,
		languageId,
		version: 1,
		getText: (range?: vscode.Range) => (range ? source.slice(offsetAt(range.start), offsetAt(range.end)) : source),
		offsetAt,
		positionAt,
		lineAt: (lineOrPosition: number | vscode.Position) => {
			const line = typeof lineOrPosition === "number" ? lineOrPosition : lineOrPosition.line;
			return {
				lineNumber: line,
				text: source.split("\n")[line] ?? "",
				range: new vscode.Range(line, 0, line, 0),
			};
		},
		getWordRangeAtPosition: () => undefined,
	} as unknown as vscode.TextDocument;
}

function createService(): LanguageService {
	return new LanguageService(new DefinitionFallback(), new ReferencesFallback(), new RenameFallback());
}

function parameterTexts(source: string, tokens: SemanticToken[]): string[] {
	return tokens.filter((token) => token.type === "parameter").map((token) => source.slice(token.start, token.end));
}

describe("semantic tokens", () => {
	it("marks a parameter declaration and its uses in the function body", () => {
		const source = "func heal(health: int) -> void:\n\thealth += 1\n\tprint(health)\n";
		const service = createService();
		try {
			const tokens = collectSemanticTokens(fakeDocument("/game/player.gd", source), service);
			assert.deepEqual(parameterTexts(source, tokens), ["health", "health", "health"]);
		} finally {
			service.dispose();
		}
	});

	it("does not mark the member side of self.health", () => {
		const source = "var health: int\nfunc heal(health: int) -> void:\n\tself.health = health\n";
		const service = createService();
		try {
			const tokens = collectSemanticTokens(fakeDocument("/game/player.gd", source), service);
			const starts = tokens.filter((token) => token.type === "parameter").map((token) => token.start);
			assert.deepEqual(parameterTexts(source, tokens), ["health", "health"]);
			assert.ok(!starts.includes(source.indexOf("self.health") + "self.".length));
			assert.ok(starts.includes(source.lastIndexOf("health")));
		} finally {
			service.dispose();
		}
	});

	it("keeps same-named locals in another function out of the parameter token", () => {
		const source = [
			"func first(health: int) -> void:",
			"\thealth += 1",
			"func second() -> void:",
			"\tvar health := 2",
			"\thealth += 1",
		].join("\n");
		const service = createService();
		try {
			const tokens = collectSemanticTokens(fakeDocument("/game/player.gd", source), service);
			assert.deepEqual(parameterTexts(source, tokens), ["health", "health"]);
			assert.ok(
				tokens.every((token) => token.type !== "parameter" || token.start < source.indexOf("func second")),
			);
		} finally {
			service.dispose();
		}
	});

	it("lets a local declaration shadow the parameter in the body", () => {
		const source = "func heal(health: int) -> void:\n\tvar health := 2\n\thealth += 1\n";
		const service = createService();
		try {
			const tokens = collectSemanticTokens(fakeDocument("/game/player.gd", source), service);
			assert.deepEqual(parameterTexts(source, tokens), ["health"]);
			assert.equal(tokens.find((token) => token.type === "parameter")?.start, source.indexOf("health"));
		} finally {
			service.dispose();
		}
	});

	it("refreshes a stale index before producing parameter tokens", () => {
		const stale = "func heal(health: int) -> void:\n\thealth += 1\n";
		const fresh = "func heal(stamina: int) -> void:\n\tstamina += 1\n";
		const service = createService();
		try {
			service.ensureDocumentIndexed(fakeDocument("/game/player.gd", stale));
			const tokens = collectSemanticTokens(fakeDocument("/game/player.gd", fresh), service);
			assert.deepEqual(parameterTexts(fresh, tokens), ["stamina", "stamina"]);
			assert.ok(
				tokens.every((token) => token.type !== "parameter" || fresh.slice(token.start, token.end) !== "health"),
			);
		} finally {
			service.dispose();
		}
	});

	it("keeps node path literals while adding parameter tokens", () => {
		const source = 'func move(path: String) -> void:\n\tget_node("Player/Camera")\n\tprint(path)\n';
		const service = createService();
		try {
			const tokens = collectSemanticTokens(fakeDocument("/game/player.gd", source), service);
			assert.deepEqual(parameterTexts(source, tokens), ["path", "path"]);
			assert.deepEqual(
				tokens
					.filter((token) => token.type === "nodePath")
					.map((token) => source.slice(token.start, token.end)),
				['"Player/Camera"'],
			);
		} finally {
			service.dispose();
		}
	});

	it("covers only the parameter name, not its type or default value", () => {
		const source = "func heal(health: int = 10) -> void:\n\thealth += 1\n";
		const service = createService();
		try {
			const tokens = collectSemanticTokens(fakeDocument("/game/player.gd", source), service);
			assert.deepEqual(parameterTexts(source, tokens), ["health", "health"]);
			assert.ok(
				tokens.every(
					(token) => token.type !== "parameter" || source.slice(token.start, token.end).trim() === "health",
				),
			);
		} finally {
			service.dispose();
		}
	});

	it("does not color a workspace parameter from another script", () => {
		const service = createService();
		try {
			service.ensureDocumentIndexed(fakeDocument("/game/other.gd", "func greet(name: String) -> void:\n\tprint(name)\n"));
			const source = "extends Node\nfunc label() -> String:\n\treturn name\n";
			const tokens = collectSemanticTokens(fakeDocument("/game/player.gd", source), service);
			assert.deepEqual(parameterTexts(source, tokens), []);
		} finally {
			service.dispose();
		}
	});

	it("does not color a parameter declared in another function", () => {
		const source = "func greet(name: String) -> void:\n\tprint(name)\nfunc label() -> String:\n\treturn name\n";
		const service = createService();
		try {
			const tokens = collectSemanticTokens(fakeDocument("/game/player.gd", source), service);
			assert.deepEqual(parameterTexts(source, tokens), ["name", "name"]);
			assert.ok(tokens.every((token) => token.type !== "parameter" || token.start < source.indexOf("func label")));
		} finally {
			service.dispose();
		}
	});

	it("does not color node shorthand that shares a parameter name", () => {
		const source = [
			"func move(player: Node) -> void:",
			"\t$player.position = player.position",
			"\t%Player.show()",
			'\tprint("%s" % player)',
		].join("\n");
		const service = createService();
		try {
			const tokens = collectSemanticTokens(fakeDocument("/game/player.gd", source), service);
			assert.deepEqual(parameterTexts(source, tokens), ["player", "player", "player"]);
			assert.ok(tokens.every((token) => token.type !== "parameter" || source[token.start - 1] !== "$"));
			assert.ok(
				tokens.every((token) => token.type !== "parameter" || source[token.start - 1] !== "%"),
			);
			assert.ok(
				tokens.some(
					(token) => token.type === "parameter" && token.start === source.lastIndexOf("player"),
				),
			);
		} finally {
			service.dispose();
		}
	});

	it("treats keywords as non-values before node shorthand", () => {
		const source = [
			"func move(player: Node) -> void:",
			"\treturn %player",
			'\tprint("%s" % player)',
		].join("\n");
		const service = createService();
		try {
			const tokens = collectSemanticTokens(fakeDocument("/game/player.gd", source), service);
			const starts = tokens.filter((token) => token.type === "parameter").map((token) => token.start);
			assert.deepEqual(parameterTexts(source, tokens), ["player", "player"]);
			assert.ok(!starts.includes(source.indexOf("%player") + 1));
			assert.ok(starts.includes(source.lastIndexOf("player")));
		} finally {
			service.dispose();
		}
	});

	it("marks inline lambda parameters", () => {
		const source = "func outer() -> void:\n\tvar cb = func(value: int) -> int: return value\n";
		const service = createService();
		try {
			const tokens = collectSemanticTokens(fakeDocument("/game/player.gd", source), service);
			assert.deepEqual(parameterTexts(source, tokens), ["value", "value"]);
		} finally {
			service.dispose();
		}
	});

	it("marks block lambda parameters without capturing lambda locals", () => {
		const source = [
			"func outer(outer_value: int) -> void:",
			"\tvar cb = func(value: int) -> int:",
			"\t\tvar local := value",
			"\t\treturn local + outer_value",
		].join("\n");
		const service = createService();
		try {
			const tokens = collectSemanticTokens(fakeDocument("/game/player.gd", source), service);
			assert.deepEqual(parameterTexts(source, tokens), ["outer_value", "value", "value", "outer_value"]);
		} finally {
			service.dispose();
		}
	});

	it("marks nested lambda parameters and their outer bindings", () => {
		const source = [
			"func outer(a: int) -> void:",
			"\tvar cb = func(b: int) -> void:",
			"\t\tvar inner = func(c: int) -> int:",
			"\t\t\treturn a + b + c",
		].join("\n");
		const service = createService();
		try {
			const tokens = collectSemanticTokens(fakeDocument("/game/player.gd", source), service);
			assert.deepEqual(parameterTexts(source, tokens), ["a", "b", "c", "a", "b", "c"]);
		} finally {
			service.dispose();
		}
	});

	it("does not color a function name that matches its parameter", () => {
		const source = "func process(process: int) -> void:\n\tprint(process)\n";
		const service = createService();
		try {
			const tokens = collectSemanticTokens(fakeDocument("/game/player.gd", source), service);
			const starts = tokens.filter((token) => token.type === "parameter").map((token) => token.start);
			const declaration = source.indexOf("process", source.indexOf("("));
			const use = source.lastIndexOf("process");
			assert.deepEqual(parameterTexts(source, tokens), ["process", "process"]);
			assert.deepEqual(starts, [declaration, use]);
		} finally {
			service.dispose();
		}
	});

	it("rebuilds bindings after a dependency-only edit", () => {
		const service = createService();
		try {
			service.ensureDocumentIndexed(fakeDocument("/game/a.gd", "extends Node\n"));
			service.ensureDocumentIndexed(fakeDocument("/game/b.gd", "extends Node\n"));
			const stale =
				'const First = preload("res://a.gd")\nfunc heal(health: int) -> void:\n\thealth += 1\n';
			const fresh =
				'const First = preload("res://b.gd")\nfunc heal(health: int) -> void:\n\tvar health := 2\n\thealth += 1\n';
			service.ensureDocumentIndexed(fakeDocument("/game/player.gd", stale));
			const tokens = collectSemanticTokens(fakeDocument("/game/player.gd", fresh), service);
			assert.deepEqual(parameterTexts(fresh, tokens), ["health"]);
			assert.equal(tokens.find((token) => token.type === "parameter")?.start, fresh.indexOf("health"));
		} finally {
			service.dispose();
		}
	});
});
