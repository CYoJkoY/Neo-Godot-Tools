import * as vscode from "vscode";
import type { ExtensionContext, SymbolInformation, WorkspaceSymbolProvider } from "vscode";
import { LanguageService } from "../language/service";
import { toSymbolInformation } from "./symbols";

export interface WorkspaceSymbolProviderOptions {
	languageService: LanguageService;
}

export type GDWorkspaceSymbolProvider = WorkspaceSymbolProvider;

export function createWorkspaceSymbolProvider(
	context: ExtensionContext,
	options: WorkspaceSymbolProviderOptions,
): GDWorkspaceSymbolProvider {
	const provider: GDWorkspaceSymbolProvider = {
		provideWorkspaceSymbols(query): SymbolInformation[] | Thenable<SymbolInformation[]> {
			// Without a mirror the provider answers synchronously from the index, so
			// existing callers and tests keep the exact previous behavior.
			if (!options.languageService.hasSymbolMirror())
				return options.languageService.getWorkspaceSymbols(query).map((symbol) => toSymbolInformation(symbol));
			return options.languageService
				.getWorkspaceSymbolsAsync(query)
				.then((symbols) => symbols.map((symbol) => toSymbolInformation(symbol)));
		},
	};
	context.subscriptions.push(vscode.languages.registerWorkspaceSymbolProvider(provider));
	return provider;
}
