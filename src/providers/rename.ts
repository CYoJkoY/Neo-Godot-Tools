import * as vscode from "vscode";
import { LanguageService } from "../language/service";

export class GDRenameProvider implements vscode.RenameProvider {
	constructor(context: vscode.ExtensionContext, private readonly languageService: LanguageService) {
		context.subscriptions.push(vscode.languages.registerRenameProvider({ language: "gdscript", scheme: "file" }, this));
	}

	provideRenameEdits(
		document: vscode.TextDocument,
		position: vscode.Position,
		newName: string,
		token: vscode.CancellationToken,
	): vscode.ProviderResult<vscode.WorkspaceEdit> {
		return this.languageService.getRenameEdits(document, position, newName, token);
	}
}
