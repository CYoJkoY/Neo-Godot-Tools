import * as vscode from "vscode";
import { DefinitionRequest } from "vscode-languageclient/node";
import { globals } from "../extension";

type LspRange = { start: { line: number; character: number }; end: { line: number; character: number } };
type LspLocation = { uri: string; range: LspRange };
type LspLocationLink = { targetUri: string; targetSelectionRange: LspRange };

export class DefinitionFallback {
	async provide(document: vscode.TextDocument, position: vscode.Position, token: vscode.CancellationToken): Promise<vscode.Location | vscode.Location[] | undefined> {
		const client = globals.lsp?.client;
		if (!client) return undefined;

		try {
			const result = await client.sendRequest(DefinitionRequest.type, {
				textDocument: { uri: document.uri.toString() },
				position: { line: position.line, character: position.character },
			}, token);
			if (!result) return undefined;
			const locations = Array.isArray(result) ? result : [result];
			return locations.map((location) => this.toLocation(location));
		} catch {
			return undefined;
		}
	}

	private toLocation(location: LspLocation | LspLocationLink): vscode.Location {
		if ("targetUri" in location) {
			return new vscode.Location(vscode.Uri.parse(location.targetUri), new vscode.Range(
				location.targetSelectionRange.start.line,
				location.targetSelectionRange.start.character,
				location.targetSelectionRange.end.line,
				location.targetSelectionRange.end.character,
			));
		}
		return new vscode.Location(vscode.Uri.parse(location.uri), new vscode.Range(
			location.range.start.line,
			location.range.start.character,
			location.range.end.line,
			location.range.end.character,
		));
	}
}
