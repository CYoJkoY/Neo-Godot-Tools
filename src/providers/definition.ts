import * as vscode from "vscode";
import {
	Position,
	TextDocument,
	CancellationToken,
	Location,
	Definition,
	DefinitionProvider,
	ExtensionContext,
	TextLine,
} from "vscode";
import { make_docs_uri } from "../utils";
import { globals } from "../extension";
import { LanguageService } from "../language/service";
import { getGDScriptBuiltin, getGDScriptBuiltinDocumentationClass } from "../language/semantic/gdscript_builtins";
import type { NativeSymbolInspectParams } from "./documentation_types";

const BUILTIN_DOCUMENTATION_CLASSES = ["@GlobalScope", "@GDScript"] as const;

export class GDDefinitionProvider implements DefinitionProvider {
	constructor(context: ExtensionContext, private readonly languageService: LanguageService) {
		const selector = [
			{ language: "gdresource", scheme: "file" },
			{ language: "gdscene", scheme: "file" },
			{ language: "gdscript", scheme: "file" },
		];
		context.subscriptions.push(vscode.languages.registerDefinitionProvider(selector, this));
	}

	async provideDefinition(document: TextDocument, position: Position, token: CancellationToken): Promise<Definition | undefined> {
		if (["gdresource", "gdscene"].includes(document.languageId)) {
			const range = document.getWordRangeAtPosition(position, /(\w+)/);
			if (range) {
				const word = document.getText(range);
				if (globals.docsProvider?.classInfo.has(word)) return new Location(make_docs_uri(word), new Position(0, 0));

				let i = 0;
				let line: TextLine;
				let match: RegExpMatchArray | null;
				do {
					line = document.lineAt(position.line - i++);
					match = line.text.match(/(?<=type)="(\w+)"/);
				} while (!match && line.lineNumber > 0);
				if (match && globals.docsProvider?.classInfo.has(match[1])) {
					return new Location(make_docs_uri(match[1], word), new Position(0, 0));
				}
			}
			return undefined;
		}

		const range = document.getWordRangeAtPosition(position, /[A-Za-z_][A-Za-z0-9_]*/);
		if (range && globals.docsProvider?.classInfo.has(document.getText(range))) {
			return new Location(make_docs_uri(document.getText(range)), new Position(0, 0));
		}

		const word = range ? document.getText(range) : undefined;
		const builtin = word ? getGDScriptBuiltin(word) : undefined;
		if (builtin) {
			// Builtins are language-level symbols, not workspace symbols. Resolve them
			// directly to the documentation provider instead of waiting for the local
			// analyzer or Godot LSP to recognize them as native members.
			const documentationClass = getGDScriptBuiltinDocumentationClass(builtin.name);
			return new Location(make_docs_uri(documentationClass, builtin.name), new Position(0, 0));
		}

		const local = await this.languageService.getDefinition(document, position, token);
		if (local) return local;

		return this.provideBuiltinSymbolDefinition(document, position, token);
	}

	private async provideBuiltinSymbolDefinition(
		document: TextDocument,
		position: Position,
		token: CancellationToken,
	): Promise<Definition | undefined> {
		if (token.isCancellationRequested) return undefined;
		const target = await globals.lsp?.client.get_symbol_at_position(document.uri, position, token);
		if (!target) return undefined;

		const separator = target.indexOf(".");
		if (separator !== -1) {
			const className = target.slice(0, separator);
			const symbolName = target.slice(separator + 1);
			if (!symbolName || !globals.docsProvider?.classInfo.has(className)) return undefined;
			return new Location(make_docs_uri(className, symbolName), new Position(0, 0));
		}

		const className = await this.resolveBuiltinSymbolClass(target, document, token);
		if (!className) return undefined;

		return new Location(make_docs_uri(className, target), new Position(0, 0));
	}

	private async resolveBuiltinSymbolClass(
		symbolName: string,
		document: TextDocument,
		token: CancellationToken,
	): Promise<string | undefined> {
		const lsp = globals.lsp?.client;
		const docs = globals.docsProvider;
		if (!lsp || !docs || token.isCancellationRequested) return undefined;

		const candidates = this.nativeClassCandidates(document);
		for (const nativeClass of candidates) {
			if (token.isCancellationRequested) return undefined;
			if (!docs.classInfo.has(nativeClass)) continue;
			if (await this.nativeSymbolExists(nativeClass, symbolName, token)) return nativeClass;
		}

		return undefined;
	}

	private nativeClassCandidates(document: TextDocument): string[] {
		const docs = globals.docsProvider;
		if (!docs) return [];

		const candidates: string[] = [];
		const seen = new Set<string>();
		const addHierarchy = (className: string) => {
			let current = className;
			while (current && !seen.has(current)) {
				seen.add(current);
				candidates.push(current);
				current = docs.classInfo.get(current)?.inherits ?? "";
			}
		};

		const text = document.getText();
		const extendsMatch = text.match(/(?:^|\n)\s*extends\s+([A-Za-z_][A-Za-z0-9_]*)/);
		if (extendsMatch) addHierarchy(extendsMatch[1]);

		for (const nativeClass of BUILTIN_DOCUMENTATION_CLASSES) {
			if (!seen.has(nativeClass)) {
				seen.add(nativeClass);
				candidates.push(nativeClass);
			}
		}

		return candidates;
	}

	private async nativeSymbolExists(className: string, symbolName: string, token: CancellationToken): Promise<boolean> {
		const lsp = globals.lsp?.client;
		if (!lsp || token.isCancellationRequested) return false;

		const params: NativeSymbolInspectParams = {
			native_class: className,
			symbol_name: symbolName,
		};

		try {
			const symbol = await lsp.sendRequest("textDocument/nativeSymbol", params, token);
			return Boolean(symbol && (symbol as { name?: string }).name === symbolName);
		} catch {
			return false;
		}
	}
}
