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
import { resolveBuiltinSymbol, type ResolvedBuiltinSymbol } from "../language/semantic/builtin_symbols";
import type { NativeSymbolInspectParams } from "./documentation_types";
import { doc_symbol_anchor } from "../utils/doc_anchor";


const BUILTIN_DOCUMENTATION_CLASSES = ["@GDScript", "@GlobalScope"] as const;

function normalizeNativeSymbolName(value: string): string {
    let normalized = value.trim();
    normalized = normalized.replace(/\s*->\s*.*$/, "").trim();
    normalized = normalized.replace(/^func\s+/, "").trim();
    normalized = normalized.replace(/\s*\([^)]*\)\s*$/, "").trim();

    const typeMatch = normalized.match(/^([A-Za-z_][A-Za-z0-9_]*)\s+(.*)/);
    if (typeMatch && typeMatch[1] !== "operator") {
        normalized = typeMatch[2].trim();
    }

    if (normalized.startsWith(".")) {
        normalized = normalized.slice(1);
    }
    
    return normalized;
}

function splitNativeSymbolTarget(value: string): { className?: string; symbolName: string } {
	const normalized = value.trim().replace(/^func\s+/, "").replace(/\s*->\s*.*$/, "").trim();
	const callable = normalized.match(/^([A-Za-z_][A-Za-z0-9_.]*)\s*\(/);
	const qualified = callable?.[1] ?? normalized.split(/\s*\(/, 1)[0];
	const separator = qualified.lastIndexOf(".");
	if (separator === -1) return { symbolName: normalizeNativeSymbolName(qualified) };
	return {
		className: qualified.slice(0, separator).trim(),
		symbolName: normalizeNativeSymbolName(qualified.slice(separator + 1)),
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

function memberReceiver(document: TextDocument, range: vscode.Range | undefined): { name: string; range: vscode.Range } | undefined {
	if (!range) return undefined;
	const before = document.getText().slice(0, document.offsetAt(range.start));
	const match = before.match(/([A-Za-z_]\w*)\.\s*$/);
	if (!match) return undefined;
	const startOffset = document.offsetAt(range.start) - match[1].length - 1;
	const start = document.positionAt(startOffset);
	return {
		name: match[1],
		range: new vscode.Range(start, document.positionAt(startOffset + match[1].length)),
	};
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
					return new Location(
						make_docs_uri(match[1], doc_symbol_anchor("property", word)),
						new Position(0, 0),
					);
				}
			}
			return undefined;
		}

		const range = document.getWordRangeAtPosition(position, /[A-Za-z_][A-Za-z0-9_]*/);
		if (!range) return undefined;

		const functionCall = isFunctionCall(document, range);
		const memberAccess = hasMemberReceiver(document, range);
		const word = document.getText(range);

		if (functionCall && !memberAccess) {
			const builtin = resolveBuiltinSymbol(word);
			if (builtin) {
				const ownerClass = await this.resolveBuiltinDocumentationClass(builtin, token);
				return new Location(
					make_docs_uri(ownerClass, doc_symbol_anchor("method", builtin.builtin.name)),
					new Position(0, 0),
				);
			}
		}

		if (!functionCall && !memberAccess && globals.docsProvider?.classInfo.has(word)) {
			return new Location(make_docs_uri(word), new Position(0, 0));
		}

		if (memberAccess) {
			const nativeMember = await this.resolveNativeMemberFromReceiver(document, range, token);
			if (nativeMember) return nativeMember;
		}

		const local = await this.languageService.getDefinition(document, position, token);
		if (local) return local;

		return this.provideBuiltinSymbolDefinition(document, position, token, range);
	}

	private async resolveNativeMemberFromReceiver(
		document: TextDocument,
		range: vscode.Range,
		token: CancellationToken,
	): Promise<Definition | undefined> {
		if (token.isCancellationRequested) return undefined;
		const receiver = memberReceiver(document, range);
		if (!receiver || !globals.docsProvider) return undefined;

		let className: string | undefined;
		if (globals.docsProvider.classInfo.has(receiver.name)) {
			className = receiver.name;
		} else {
			const type = this.languageService.types.resolveReceiver(document.uri.toString(), document.offsetAt(receiver.range.start), receiver.name);
			if (type?.builtin && globals.docsProvider.classInfo.has(type.name)) className = type.name;
		}

		if (!className) return undefined;
		const symbolName = document.getText(range);
		const owner = await this.resolveNativeMemberOwner(className, symbolName, token);
		if (!owner) return undefined;
		return new Location(
			make_docs_uri(owner.className, doc_symbol_anchor(owner.kind, symbolName)),
			new Position(0, 0),
		);
	}

	private async provideBuiltinSymbolDefinition(
		document: TextDocument,
		position: Position,
		token: CancellationToken,
		range: vscode.Range,
	): Promise<Definition | undefined> {
		if (token.isCancellationRequested) return undefined;
		const target = await globals.lsp?.client.get_symbol_at_position(document.uri, position, token);
		if (!target) return undefined;

		const { className: explicitClassName, symbolName } = splitNativeSymbolTarget(target);
		if (!symbolName) return undefined;

		if (explicitClassName && globals.docsProvider?.classInfo.has(explicitClassName)) {
			const owner = await this.resolveNativeMemberOwner(explicitClassName, symbolName, token);
			if (owner) {
				return new Location(
					make_docs_uri(owner.className, doc_symbol_anchor(owner.kind, symbolName)),
					new Position(0, 0),
				);
			}
		}
		const builtin = resolveBuiltinSymbol(symbolName);
		if (builtin) {
			const ownerClass = await this.resolveBuiltinDocumentationClass(builtin, token);
			return new Location(
				make_docs_uri(ownerClass, doc_symbol_anchor("method", builtin.builtin.name)),
				new Position(0, 0),
			);
		}

		const receiver = memberReceiver(document, range);
		if (receiver) {
			let receiverClass: string | undefined;
			if (globals.docsProvider?.classInfo.has(receiver.name)) {
				receiverClass = receiver.name;
			} else {
				const type = this.languageService.types.resolveReceiver(document.uri.toString(), document.offsetAt(receiver.range.start), receiver.name);
				if (type?.builtin && globals.docsProvider?.classInfo.has(type.name)) receiverClass = type.name;
			}
			if (receiverClass) {
				const owner = await this.resolveNativeMemberOwner(receiverClass, symbolName, token);
				if (owner) {
					return new Location(
						make_docs_uri(owner.className, doc_symbol_anchor(owner.kind, symbolName)),
						new Position(0, 0),
					);
				}
			}
		}
		const className = await this.resolveBuiltinSymbolClass(symbolName, document, token);
		if (!className) return undefined;
		const info = await this.nativeSymbolInfo(className, symbolName, token);
		return new Location(make_docs_uri(className, doc_symbol_anchor(info?.kind, symbolName)), new Position(0, 0));
	}

	private async resolveNativeMemberClass(className: string, symbolName: string, token: CancellationToken): Promise<string | undefined> {
		const docs = globals.docsProvider;
		if (!docs || token.isCancellationRequested) return undefined;

		const visited = new Set<string>();
		let current = className;
		while (current && !visited.has(current)) {
			visited.add(current);
			if (docs.classInfo.has(current) && (await this.nativeSymbolExists(current, symbolName, token))) return current;
			current = docs.classInfo.get(current)?.inherits ?? "";
		}
		return undefined;
	}

	private async resolveBuiltinSymbolClass(
		symbolName: string,
		document: TextDocument,
		token: CancellationToken,
	): Promise<string | undefined> {
		const docs = globals.docsProvider;
		if (!docs || token.isCancellationRequested) return undefined;

		const candidates = this.nativeClassCandidates(document);
		for (const nativeClass of candidates) {
			if (token.isCancellationRequested) return undefined;
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

	private async nativeSymbolInfo(
		className: string,
		symbolName: string,
		token: CancellationToken,
	): Promise<{ name?: string; kind?: string } | undefined> {
		const lsp = globals.lsp?.client;
		if (!lsp || token.isCancellationRequested) return undefined;
		const params: NativeSymbolInspectParams = { native_class: className, symbol_name: symbolName };
		try {
			const symbol = await lsp.sendRequest("textDocument/nativeSymbol", params, token);
			return symbol as { name?: string; kind?: string } | undefined;
		} catch {
			return undefined;
		}
	}

	private async resolveNativeMemberOwner(
		className: string,
		symbolName: string,
		token: CancellationToken,
	): Promise<{ className: string; kind?: string } | undefined> {
		const docs = globals.docsProvider;
		if (!docs || token.isCancellationRequested) return undefined;
		const visited = new Set<string>();
		let current = className;
		while (current && !visited.has(current)) {
			visited.add(current);
			if (docs.classInfo.has(current)) {
				const info = await this.nativeSymbolInfo(current, symbolName, token);
				if (info?.name === symbolName) return { className: current, kind: info.kind };
			}
			current = docs.classInfo.get(current)?.inherits ?? "";
		}
		return undefined;
	}

	private async resolveBuiltinDocumentationClass(
		builtin: ResolvedBuiltinSymbol,
		token: CancellationToken,
	): Promise<string> {
		const preferred = builtin.documentationClass;
		const fallback = preferred === "@GDScript" ? "@GlobalScope" : "@GDScript";
		if (token.isCancellationRequested) return preferred;
		if (await this.nativeSymbolExists(preferred, builtin.builtin.name, token)) return preferred;
		if (await this.nativeSymbolExists(fallback, builtin.builtin.name, token)) return fallback;
		return preferred;
	}
}
