import * as vscode from "vscode";
import { RenameRequest } from "vscode-languageclient/node";
import { globals } from "../extension";

type LspTextEdit = { range: { start: { line: number; character: number }; end: { line: number; character: number } }; newText: string };
type LspWorkspaceEdit = {
	changes?: Record<string, LspTextEdit[]>;
	documentChanges?: Array<{ textDocument: { uri: string }; edits: LspTextEdit[] }>;
};

export class RenameFallback {
	async provide(
		document: vscode.TextDocument,
		position: vscode.Position,
		newName: string,
		token: vscode.CancellationToken,
	): Promise<vscode.WorkspaceEdit | undefined> {
		const client = globals.lsp?.client;
		if (!client) return undefined;
		try {
			const result = await client.sendRequest(RenameRequest.type, {
				textDocument: { uri: document.uri.toString() },
				position: { line: position.line, character: position.character },
				newName,
			}, token) as LspWorkspaceEdit | null | undefined;
			return this.toWorkspaceEdit(result);
		} catch {
			return undefined;
		}
	}

	private toWorkspaceEdit(result: LspWorkspaceEdit | null | undefined): vscode.WorkspaceEdit | undefined {
		if (!result) return undefined;
		const edit = new vscode.WorkspaceEdit();
		for (const [uri, edits] of Object.entries(result.changes ?? {})) this.applyEdits(edit, vscode.Uri.parse(uri), edits);
		for (const change of result.documentChanges ?? []) this.applyEdits(edit, vscode.Uri.parse(change.textDocument.uri), change.edits);
		return edit;
	}

	private applyEdits(edit: vscode.WorkspaceEdit, uri: vscode.Uri, edits: LspTextEdit[]): void {
		for (const textEdit of edits) edit.replace(uri, new vscode.Range(
			textEdit.range.start.line,
			textEdit.range.start.character,
			textEdit.range.end.line,
			textEdit.range.end.character,
		), textEdit.newText);
	}
}
