import * as vscode from "vscode";
import { LanguageService } from "../language/service";

export class GDReferenceProvider implements vscode.ReferenceProvider {
	constructor(context: vscode.ExtensionContext, private readonly languageService: LanguageService) {
		context.subscriptions.push(vscode.languages.registerReferenceProvider({ language: "gdscript", scheme: "file" }, this));
	}

	provideReferences(
		document: vscode.TextDocument,
		position: vscode.Position,
		context: vscode.ReferenceContext,
		token: vscode.CancellationToken,
	): Promise<vscode.Location[] | undefined> {
		return this.languageService.getReferences(document, position, context.includeDeclaration, token);
	}
}
