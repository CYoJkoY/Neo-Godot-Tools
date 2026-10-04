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
		provideWorkspaceSymbols(query): SymbolInformation[] {
			return options.languageService.getWorkspaceSymbols(query).map((symbol) => toSymbolInformation(symbol));
		},
	};
	context.subscriptions.push(vscode.languages.registerWorkspaceSymbolProvider(provider));
	return provider;
}
