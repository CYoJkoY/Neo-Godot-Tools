import * as vscode from "vscode";
import { SignatureHelpFallback } from "../fallback/signature_help";
import { LanguageService } from "../language/service";

export class GDSignatureHelpProvider implements vscode.SignatureHelpProvider {
	constructor(context: vscode.ExtensionContext, private readonly languageService: LanguageService, private readonly fallback = new SignatureHelpFallback()) {
		context.subscriptions.push(vscode.languages.registerSignatureHelpProvider(
			{ language: "gdscript", scheme: "file" },
			this,
			"(", ",",
		));
	}

	async provideSignatureHelp(document: vscode.TextDocument, position: vscode.Position, token: vscode.CancellationToken, context: vscode.SignatureHelpContext): Promise<vscode.SignatureHelp | undefined> {
		if (token.isCancellationRequested) return undefined;
		const local = this.languageService.getSignatureHelp(document, position, token);
		if (local) return local;
		if (token.isCancellationRequested) return undefined;
		return this.fallback.provide(document, position, context, token);
	}
}
