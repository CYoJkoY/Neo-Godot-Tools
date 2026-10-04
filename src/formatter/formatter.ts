import * as vscode from "vscode";
import { format_document_async } from "./textmate";

export class FormattingProvider implements vscode.DocumentFormattingEditProvider {
	constructor(context: vscode.ExtensionContext) {
		const selector = { language: "gdscript", scheme: "file" };

		context.subscriptions.push(vscode.languages.registerDocumentFormattingEditProvider(selector, this));
	}

	public provideDocumentFormattingEdits(document: vscode.TextDocument) {
		return format_document_async(document);
	}
}
