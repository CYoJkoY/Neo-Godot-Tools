import * as vscode from "vscode";
import type { IndexedSymbol } from "../index";
import { functionSignature } from "../index/symbol_label";

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
		case "enum_member":
			return vscode.SymbolKind.EnumMember;
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

/**
 * The trailing hint of an outline entry: a callable signature, a declared type,
 * or the base class. Declarations with nothing to add stay empty instead of
 * repeating their kind, which the icon already shows.
 */
function symbolDetail(symbol: IndexedSymbol): string {
	if (symbol.kind === "function" || symbol.kind === "signal") return functionSignature(symbol);
	if (symbol.type) return symbol.type;
	if (symbol.extendsName) return `extends ${symbol.extendsName}`;
	return "";
}

/** The declaring identifier, which the outline selects and the sticky header reveals. */
function selectionRange(symbol: IndexedSymbol, document: vscode.TextDocument): vscode.Range {
	const start = symbol.nameOffset ?? symbol.range.start.offset;
	return new vscode.Range(document.positionAt(start), document.positionAt(start + symbol.name.length));
}

/**
 * The nested outline form of an indexed symbol.
 *
 * Unlike `SymbolInformation`, `DocumentSymbol` carries the full range and a
 * selection range, which is what sticky scroll and the breadcrumbs need.
 */
export function toDocumentSymbol(symbol: IndexedSymbol, document: vscode.TextDocument): vscode.DocumentSymbol {
	// The same fields the `DocumentSymbol` constructor assigns, written out so
	// the provider needs no `vscode` constructor at runtime.
	return {
		name: symbol.name,
		detail: symbolDetail(symbol),
		kind: symbolKind(symbol.kind),
		range: symbolRange(symbol),
		selectionRange: selectionRange(symbol, document),
		children: [],
	};
}
