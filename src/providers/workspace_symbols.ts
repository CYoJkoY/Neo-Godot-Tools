import * as vscode from "vscode";
import { LanguageService } from "../language/service";
import { IndexedSymbol } from "../index";

export class GDWorkspaceSymbolProvider implements vscode.WorkspaceSymbolProvider {
	constructor(context: vscode.ExtensionContext, private readonly service: LanguageService) {
		context.subscriptions.push(vscode.languages.registerWorkspaceSymbolProvider(this));
	}

	provideWorkspaceSymbols(query: string): vscode.SymbolInformation[] {
		return this.service.getWorkspaceSymbols(query).map((symbol) => new vscode.SymbolInformation(
			symbol.name,
			this.kind(symbol.kind),
			new vscode.Location(vscode.Uri.parse(symbol.uri), this.range(symbol)),
			symbol.containerName,
		));
	}

	private range(symbol: IndexedSymbol): vscode.Range {
		return new vscode.Range(symbol.range.start.line, symbol.range.start.character, symbol.range.end.line, symbol.range.end.character);
	}

	private kind(kind: IndexedSymbol["kind"]): vscode.SymbolKind {
		switch (kind) {
			case "class":
			case "class_name": return vscode.SymbolKind.Class;
			case "function": return vscode.SymbolKind.Function;
			case "signal": return vscode.SymbolKind.Event;
			case "enum": return vscode.SymbolKind.Enum;
			case "constant": return vscode.SymbolKind.Constant;
			case "variable": return vscode.SymbolKind.Variable;
			default: return vscode.SymbolKind.Namespace;
		}
	}
}
