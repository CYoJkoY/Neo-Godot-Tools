import * as vscode from "vscode";
import type { ExtensionContext, RenameProvider } from "vscode";
import { LanguageService } from "../language/service";

export interface RenameProviderOptions {
	languageService: LanguageService;
}

export type GDRenameProvider = RenameProvider;

export function createRenameProvider(context: ExtensionContext, options: RenameProviderOptions): GDRenameProvider {
	const provider: GDRenameProvider = {
		provideRenameEdits(document, position, newName, token): vscode.ProviderResult<vscode.WorkspaceEdit> {
			return options.languageService.getRenameEdits(document, position, newName, token);
		},
	};
	context.subscriptions.push(
		vscode.languages.registerRenameProvider({ language: "gdscript", scheme: "file" }, provider),
	);
	return provider;
}
