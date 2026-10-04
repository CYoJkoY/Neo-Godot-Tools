import * as vscode from "vscode";
import type { CompletionItemProvider, ExtensionContext } from "vscode";
import { CompletionFallback } from "../fallback/completion";
import { LanguageService } from "../language/service";
import { RESOURCE_SELECTOR } from "./selectors";

export interface CompletionProviderOptions {
	languageService: LanguageService;
	fallback?: CompletionFallback;
}

export interface GDCompletionItemProvider extends CompletionItemProvider {
	provideCompletionItems(
		document: vscode.TextDocument,
		position: vscode.Position,
		token: vscode.CancellationToken,
		context: vscode.CompletionContext,
	): Promise<vscode.CompletionList | vscode.CompletionItem[] | undefined>;
}

export function createCompletionItemProvider(
	context: ExtensionContext,
	options: CompletionProviderOptions,
): GDCompletionItemProvider {
	const fallback = options.fallback ?? new CompletionFallback();
	const provider: GDCompletionItemProvider = {
		async provideCompletionItems(document, position, token, completionContext) {
			if (token.isCancellationRequested) return undefined;
			if (document.languageId !== "gdscript")
				return fallback.provide(document, position, completionContext, token);
			const local = options.languageService.getCompletions(document, position, token);
			if (local) return local;
			if (token.isCancellationRequested) return undefined;
			return fallback.provide(document, position, completionContext, token);
		},
	};
	context.subscriptions.push(vscode.languages.registerCompletionItemProvider(RESOURCE_SELECTOR, provider));
	return provider;
}
