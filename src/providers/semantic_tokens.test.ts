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
});
