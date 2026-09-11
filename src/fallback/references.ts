import * as vscode from "vscode";
import { ReferencesRequest } from "vscode-languageclient/node";
import { globals } from "../extension";

type LspRange = { start: { line: number; character: number }; end: { line: number; character: number } };
type LspLocation = { uri: string; range: LspRange };

export class ReferencesFallback {
	async provide(
		document: vscode.TextDocument,
		position: vscode.Position,
		context: vscode.ReferenceContext,
		token: vscode.CancellationToken,
	): Promise<vscode.Location[] | undefined> {
		const client = globals.lsp?.client;
		if (!client) return undefined;
		try {
			const result = await client.sendRequest(ReferencesRequest.type, {
				textDocument: { uri: document.uri.toString() },
				position: { line: position.line, character: position.character },
				context: { includeDeclaration: context.includeDeclaration },
			}, token);
			return result?.map((location: LspLocation) => new vscode.Location(
				vscode.Uri.parse(location.uri),
				new vscode.Range(
					location.range.start.line,
					location.range.start.character,
					location.range.end.line,
					location.range.end.character,
				),
			));
		} catch {
			return undefined;
		}
	}
}
