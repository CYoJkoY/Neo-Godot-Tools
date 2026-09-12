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
import { resolveBuiltinSymbol } from "../language/semantic/builtin_symbols";
import type { NativeSymbolInspectParams } from "./documentation_types";

const BUILTIN_DOCUMENTATION_CLASSES = ["@GlobalScope", "@GDScript"] as const;

function normalizeNativeSymbolName(value: string): string {
	const normalized = value.trim().replace(/\s+/g, " ");
	const qualified = normalized.match(/(?:^|\.)((?:[A-Za-z_][A-Za-z0-9_]*))(?:\s*\([^)]*\))?$/);
	return qualified?.[1] ?? normalized.replace(/\s*\([^)]*\)\s*$/, "");
}

function splitNativeSymbolTarget(value: string): { className?: string; symbolName: string } {
	const normalized = value.trim();
	const separator = normalized.indexOf(".");
	if (separator === -1) return { symbolName: normalizeNativeSymbolName(normalized) };
	return {
		className: normalized.slice(0, separator).trim(),
		symbolName: normalizeNativeSymbolName(normalized.slice(separator + 1)),
	};
}

function isFunctionCall(document: TextDocument, range: vscode.Range): boolean {
	const after = document.getText().slice(document.offsetAt(range.end));
	return /^\s*\(/.test(after);
}

function hasMemberReceiver(document: TextDocument, range: vscode.Range): boolean {
	const before = document.getText().slice(0, document.offsetAt(range.start));
	return /[A-Za-z_]\w*\.\s*$/.test(before) || /\.\s*$/.test(before);
}

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
		if (!range) return undefined;

		const functionCall = isFunctionCall(document, range);
		const memberAccess = hasMemberReceiver(document, range);
		const word = document.getText(range);

		// GDScript function-call tokens are resolved as functions. For bare calls,
		// prefer the built-in function table before workspace symbols because names
		// such as `int` can also be valid class names.
		if (functionCall && !memberAccess) {
			const builtin = resolveBuiltinSymbol(word);
			if (builtin) {
				return new Location(make_docs_uri(builtin.documentationClass, builtin.builtin.name), new Position(0, 0));
			}
		}

		// Class-name tokens are resolved as classes, not as functions. This is
		// intentionally checked only outside function-call syntax because names
		// such as `int` may legally denote both a class and a conversion function.
		if (!functionCall && !memberAccess && globals.docsProvider?.classInfo.has(word)) {
			return new Location(make_docs_uri(word), new Position(0, 0));
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

		const { className: explicitClassName, symbolName } = splitNativeSymbolTarget(target);
		if (!symbolName) return undefined;

		if (explicitClassName && globals.docsProvider?.classInfo.has(explicitClassName)) {
			return new Location(make_docs_uri(explicitClassName, symbolName), new Position(0, 0));
		}

		const className = await this.resolveBuiltinSymbolClass(symbolName, document, token);
		if (!className) return undefined;

		return new Location(make_docs_uri(className, symbolName), new Position(0, 0));
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
