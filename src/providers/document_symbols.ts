import * as vscode from "vscode";
import type { DocumentSymbolProvider, ExtensionContext, SymbolInformation } from "vscode";
import { LanguageService } from "../language/service";
import { toSymbolInformation } from "./symbols";

export interface DocumentSymbolProviderOptions {
	languageService: LanguageService;
}

export type GDDocumentSymbolProvider = DocumentSymbolProvider;

/** The flat symbol list of a script; the index already resolved the hierarchy. */
export function createDocumentSymbolProvider(
	context: ExtensionContext,
	options: DocumentSymbolProviderOptions,
): GDDocumentSymbolProvider {
	const provider: GDDocumentSymbolProvider = {
		provideDocumentSymbols(document): SymbolInformation[] {
			return options.languageService
				.getDocumentSymbols(document.uri.toString())
				.map((symbol) => toSymbolInformation(symbol));
		},
	};
	context.subscriptions.push(
		vscode.languages.registerDocumentSymbolProvider({ language: "gdscript", scheme: "file" }, provider),
	);
	return provider;
}
