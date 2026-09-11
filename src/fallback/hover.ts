import * as vscode from "vscode";
import { HoverRequest } from "vscode-languageclient/node";
import { globals } from "../extension";

type LspHover = { contents?: unknown; range?: unknown };

export class HoverFallback {
	async provide(document: vscode.TextDocument, position: vscode.Position, token: vscode.CancellationToken): Promise<vscode.Hover | undefined> {
		const client = globals.lsp?.client;
		if (!client) return undefined;
		try {
			const result = await client.sendRequest(HoverRequest.type, {
				textDocument: { uri: document.uri.toString() },
				position: { line: position.line, character: position.character },
			}, token) as LspHover | null | undefined;
			if (!result?.contents) return undefined;
			return this.toHover(result);
		} catch {
			return undefined;
		}
	}

	private toHover(result: LspHover): vscode.Hover {
		const markdown = new vscode.MarkdownString();
		const contents = Array.isArray(result.contents) ? result.contents : [result.contents];
		for (const content of contents) {
			if (typeof content === "string") markdown.appendMarkdown(content);
			else if (content && typeof content === "object" && "value" in content) {
				const value = (content as { value: unknown }).value;
				if (typeof value === "string") markdown.appendMarkdown(value);
			}
		}
		return new vscode.Hover(markdown);
	}
}
