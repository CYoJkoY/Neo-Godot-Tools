import * as vscode from "vscode";
import { CompletionFallback } from "../fallback/completion";
import { LanguageService } from "../language/service";

export class GDCompletionItemProvider implements vscode.CompletionItemProvider {
	constructor(private readonly context: vscode.ExtensionContext, private readonly languageService: LanguageService, private readonly fallback = new CompletionFallback()) {
		const selector = [
			{ language: "gdresource", scheme: "file" },
			{ language: "gdscene", scheme: "file" },
			{ language: "gdscript", scheme: "file" },
		];
		context.subscriptions.push(vscode.languages.registerCompletionItemProvider(selector, this));
	}

	async provideCompletionItems(document: vscode.TextDocument, position: vscode.Position, token: vscode.CancellationToken, context: vscode.CompletionContext): Promise<vscode.CompletionList | vscode.CompletionItem[] | undefined> {
		if (document.languageId !== "gdscript") return this.fallback.provide(document, position, context, token);
		const local = this.languageService.getCompletions(document, position);
		if (local) return local;
		return this.fallback.provide(document, position, context, token);
	}
}
