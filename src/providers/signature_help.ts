import * as vscode from "vscode";
import type { ExtensionContext, SignatureHelpProvider } from "vscode";
import { SignatureHelpFallback } from "../fallback/signature_help";
import { LanguageService } from "../language/service";

export interface SignatureHelpProviderOptions {
	languageService: LanguageService;
	fallback?: SignatureHelpFallback;
}

export interface GDSignatureHelpProvider extends SignatureHelpProvider {
	provideSignatureHelp(
		document: vscode.TextDocument,
		position: vscode.Position,
		token: vscode.CancellationToken,
		context: vscode.SignatureHelpContext,
	): Promise<vscode.SignatureHelp | undefined>;
}

export function createSignatureHelpProvider(
	context: ExtensionContext,
	options: SignatureHelpProviderOptions,
): GDSignatureHelpProvider {
	const fallback = options.fallback ?? new SignatureHelpFallback();
	const provider: GDSignatureHelpProvider = {
		async provideSignatureHelp(document, position, token, signatureContext) {
			if (token.isCancellationRequested) return undefined;
			const local = options.languageService.getSignatureHelp(document, position, token);
			if (local) return local;
			if (token.isCancellationRequested) return undefined;
			return fallback.provide(document, position, signatureContext, token);
		},
	};
	context.subscriptions.push(
		vscode.languages.registerSignatureHelpProvider({ language: "gdscript", scheme: "file" }, provider, "(", ","),
	);
	return provider;
}
