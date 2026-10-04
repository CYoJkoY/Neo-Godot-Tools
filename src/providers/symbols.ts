import * as vscode from "vscode";
import type { IndexedSymbol } from "../index";

/** The range of an indexed symbol, in the coordinates VS Code uses. */
export function symbolRange(symbol: IndexedSymbol): vscode.Range {
	return new vscode.Range(
		symbol.range.start.line,
		symbol.range.start.character,
		symbol.range.end.line,
		symbol.range.end.character,
	);
}

/** The `SymbolKind` of an indexed symbol. */
export function symbolKind(kind: IndexedSymbol["kind"]): vscode.SymbolKind {
	switch (kind) {
		case "class":
		case "class_name":
			return vscode.SymbolKind.Class;
		case "function":
			return vscode.SymbolKind.Function;
		case "signal":
			return vscode.SymbolKind.Event;
		case "enum":
			return vscode.SymbolKind.Enum;
		case "constant":
			return vscode.SymbolKind.Constant;
		case "variable":
			return vscode.SymbolKind.Variable;
		default:
			return vscode.SymbolKind.Namespace;
	}
}

/** The flat `SymbolInformation` both symbol providers answer with. */
export function toSymbolInformation(symbol: IndexedSymbol): vscode.SymbolInformation {
	return new vscode.SymbolInformation(
		symbol.name,
		symbolKind(symbol.kind),
		symbolRange(symbol),
		vscode.Uri.parse(symbol.uri),
		symbol.containerName,
	);
}
