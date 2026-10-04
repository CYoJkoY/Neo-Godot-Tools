import * as vscode from "vscode";
import type { ExtensionContext, ReferenceProvider } from "vscode";
import { LanguageService } from "../language/service";

export interface ReferenceProviderOptions {
	languageService: LanguageService;
}

export type GDReferenceProvider = ReferenceProvider;

export function createReferenceProvider(
	context: ExtensionContext,
	options: ReferenceProviderOptions,
): GDReferenceProvider {
	const provider: GDReferenceProvider = {
		provideReferences(document, position, referenceContext, token): Promise<vscode.Location[] | undefined> {
			return options.languageService.getReferences(
				document,
				position,
				referenceContext.includeDeclaration,
				token,
			);
		},
	};
	context.subscriptions.push(
		vscode.languages.registerReferenceProvider({ language: "gdscript", scheme: "file" }, provider),
	);
	return provider;
}
