import * as vscode from "vscode";
import { CompletionRequest } from "vscode-languageclient/node";
import { globals } from "../extension";

type LspCompletionItem = {
	label: string;
	detail?: string;
	documentation?: string | { value: string };
	kind?: number;
	insertText?: string;
};
type LspCompletion = { items?: LspCompletionItem[]; isIncomplete?: boolean } | LspCompletionItem[];

export class CompletionFallback {
	async provide(
		document: vscode.TextDocument,
		position: vscode.Position,
		context: vscode.CompletionContext,
		token: vscode.CancellationToken,
	): Promise<vscode.CompletionList | undefined> {
		const client = globals.lsp?.client;
		if (!client) return undefined;
		try {
			const params = client.code2ProtocolConverter.asCompletionParams(document, position, context);
			const result = (await client.sendRequest(CompletionRequest.type, params, token)) as
				| LspCompletion
				| null
				| undefined;
			if (!result) return undefined;
			const items = Array.isArray(result) ? result : (result.items ?? []);
			return new vscode.CompletionList(
				items.map((item, index) => this.toItem(item, index)),
				!Array.isArray(result) && result.isIncomplete,
			);
		} catch {
			return undefined;
		}
	}

	private toItem(item: LspCompletionItem, index: number): vscode.CompletionItem {
		const completion = new vscode.CompletionItem(item.label);
		// The Godot language server already returns items in its preferred order;
		// encode it so VS Code does not fall back to alphabetical sorting.
		completion.sortText = String(index).padStart(6, "0");
		completion.detail = item.detail;
		completion.insertText = item.insertText;
		if (typeof item.documentation === "string")
			completion.documentation = new vscode.MarkdownString(item.documentation);
		else if (item.documentation) completion.documentation = new vscode.MarkdownString(item.documentation.value);
		if (typeof item.kind === "number") completion.kind = item.kind as vscode.CompletionItemKind;
		return completion;
	}
}
