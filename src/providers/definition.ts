import * as vscode from "vscode";
import { Position, TextDocument, CancellationToken, Location, Definition, DefinitionProvider, ExtensionContext, TextLine } from "vscode";
import { make_docs_uri } from "../utils";
import { globals } from "../extension";
import { LanguageService } from "../language/service";

export class GDDefinitionProvider implements DefinitionProvider {
	constructor(context: ExtensionContext, private readonly languageService: LanguageService) {
		const selector = [
			{ language: "gdresource", scheme: "file" },
			{ language: "gdscene", scheme: "file" },
			{ language: "gdscript", scheme: "file" },
		];
		context.subscriptions.push(vscode.languages.registerDefinitionProvider(selector, this));
	}

	async provideDefinition(document: TextDocument, position: Position, token: CancellationToken): Promise<Definition | undefined> {
		if (["gdresource", "gdscene"].includes(document.languageId)) {
			const range = document.getWordRangeAtPosition(position, /(\w+)/);
			if (range) {
				const word = document.getText(range);
				if (globals.docsProvider?.classInfo.has(word)) return new Location(make_docs_uri(word), new Position(0, 0));

				let i = 0;
				let line: TextLine;
				let match: RegExpMatchArray | null;
				do {
					line = document.lineAt(position.line - i++);
					match = line.text.match(/(?<=type)="(\w+)"/);
				} while (!match && line.lineNumber > 0);
				if (match && globals.docsProvider?.classInfo.has(match[1])) {
					return new Location(make_docs_uri(match[1], word), new Position(0, 0));
				}
			}
			return undefined;
		}

		return this.languageService.getDefinition(document, position, token);
	}
}
