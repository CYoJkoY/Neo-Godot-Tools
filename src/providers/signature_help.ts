import * as vscode from "vscode";
import { SignatureHelpFallback } from "../fallback/signature_help";
import { LanguageService } from "../language/service";

export class GDSignatureHelpProvider implements vscode.SignatureHelpProvider {
	constructor(private readonly context: vscode.ExtensionContext, private readonly languageService: LanguageService, private readonly fallback = new SignatureHelpFallback()) {
		context.subscriptions.push(vscode.languages.registerSignatureHelpProvider(
			{ language: "gdscript", scheme: "file" },
			this,
			"(", ",",
		));
	}

	async provideSignatureHelp(document: vscode.TextDocument, position: vscode.Position, context: vscode.SignatureHelpContext, token: vscode.CancellationToken): Promise<vscode.SignatureHelp | undefined> {
		const local = this.languageService.getSignatureHelp(document, position);
		if (local) return local;
		return this.fallback.provide(document, position, context, token);
	}
}
