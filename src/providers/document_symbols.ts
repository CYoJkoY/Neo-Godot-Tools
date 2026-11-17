import * as vscode from "vscode";
import type { DocumentSymbol, DocumentSymbolProvider, ExtensionContext, TextDocument } from "vscode";
import type { IndexedSymbol } from "../index";
import { addToGroup } from "../index/collections";
import type { LanguageService } from "../language/service";
import { toDocumentSymbol } from "./symbols";

export interface DocumentSymbolProviderOptions {
	languageService: LanguageService;
}

export type GDDocumentSymbolProvider = DocumentSymbolProvider;

interface SymbolNode {
	readonly indexed: IndexedSymbol;
	readonly outline: DocumentSymbol;
}

type SymbolNodes = ReadonlyMap<string, readonly SymbolNode[]>;

function containsSymbol(parent: IndexedSymbol, child: IndexedSymbol): boolean {
	return parent.range.start.offset < child.range.start.offset && parent.range.end.offset >= child.range.end.offset;
}

/** Both lookups the tree needs: containers by the range that starts them, and by name. */
function containerLookups(nodes: readonly SymbolNode[]): {
	byOffset: ReadonlyMap<number, SymbolNode>;
	byName: SymbolNodes;
} {
	const containers = nodes.filter(({ indexed }) => indexed.kind === "class" || indexed.kind === "enum");
	const byName = containers.reduce((groups, node) => {
		addToGroup(groups, node.indexed.name, node);
		return groups;
	}, new Map<string, SymbolNode[]>());
	return { byOffset: new Map(containers.map((node) => [node.indexed.range.start.offset, node])), byName };
}

function namedOwner(symbol: IndexedSymbol, byName: SymbolNodes, kind: IndexedSymbol["kind"]): SymbolNode | undefined {
	return (byName.get(symbol.containerName ?? "") ?? []).find(
		(node) => node.indexed.kind === kind && containsSymbol(node.indexed, symbol),
	);
}

/**
 * The declaration that owns `symbol` in the outline.
 *
 * The index identifies a nested declaration by the range of its enclosing
 * class, which is the same link binding resolution uses. Enum members point at
 * the class that holds the enum, so a member of a named enum resolves through
 * the enum name first; the members of an unnamed enum stay with the class.
 */
function ownerOf(
	symbol: IndexedSymbol,
	byOffset: ReadonlyMap<number, SymbolNode>,
	byName: SymbolNodes,
): SymbolNode | undefined {
	const enumerated = symbol.kind === "enum_member" ? namedOwner(symbol, byName, "enum") : undefined;
	if (enumerated) return enumerated;
	if (symbol.containerRange === undefined) return undefined;
	const ranged = byOffset.get(symbol.containerRange.start.offset);
	if (ranged && containsSymbol(ranged.indexed, symbol)) return ranged;
	return namedOwner(symbol, byName, "class");
}

function symbolTree(symbols: readonly IndexedSymbol[], document: TextDocument): DocumentSymbol[] {
	const nodes = symbols.map((indexed) => ({ indexed, outline: toDocumentSymbol(indexed, document) }));
	const { byOffset, byName } = containerLookups(nodes);
	return nodes.reduce<DocumentSymbol[]>((roots, node) => {
		const parent = ownerOf(node.indexed, byOffset, byName);
		if (parent === undefined) roots.push(node.outline);
		else parent.outline.children.push(node.outline);
		return roots;
	}, []);
}

export function createDocumentSymbolProvider(
	context: ExtensionContext,
	options: DocumentSymbolProviderOptions,
): GDDocumentSymbolProvider {
	const provider: GDDocumentSymbolProvider = {
		async provideDocumentSymbols(document, token): Promise<DocumentSymbol[]> {
			if (token.isCancellationRequested) return [];
			await options.languageService.ensureDocumentIndexed(document);
			if (token.isCancellationRequested) return [];
			const uri = document.uri.toString();
			// A newer keystroke may have superseded the queued update; answering from
			// an older revision would place the outline at the wrong lines.
			if (options.languageService.files.get(uri)?.source !== document.getText()) return [];
			return symbolTree(options.languageService.getDocumentSymbols(uri), document);
		},
	};
	context.subscriptions.push(
		vscode.languages.registerDocumentSymbolProvider({ language: "gdscript", scheme: "file" }, provider),
	);
	return provider;
}
