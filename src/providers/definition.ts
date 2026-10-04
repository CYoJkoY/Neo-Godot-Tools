import * as vscode from "vscode";
import type {
	CancellationToken,
	Definition,
	DefinitionProvider,
	ExtensionContext,
	Location,
	Position,
	TextDocument,
} from "vscode";
import type { ResolvedBuiltinSymbol } from "../language/semantic/builtin_symbols";
import { resolveBuiltinSymbol } from "../language/semantic/builtin_symbols";
import { LanguageService } from "../language/service";
import { make_docs_uri } from "../utils";
import { doc_symbol_anchor } from "../utils/doc_anchor";
import type { GodotNativeClassInfo } from "./documentation_types";
import type { NativeSymbolInspectParams } from "./documentation_types";
import { RESOURCE_SELECTOR } from "./selectors";

const BUILTIN_DOCUMENTATION_CLASSES = ["@GDScript", "@GlobalScope"] as const;
const DOC_POSITION = new vscode.Position(0, 0);
const WORD_PATTERN = /[A-Za-z_][A-Za-z0-9_]*/;
const TYPE_ATTRIBUTE_PATTERN = /(?<=type)="(\w+)"/;
const EXTENDS_PATTERN = /(?:^|\n)\s*extends\s+([A-Za-z_][A-Za-z0-9_]*)/;

/** The language-client surface definition lookups use. */
export interface DefinitionLspClient {
	sendRequest(method: string, params?: unknown, token?: unknown): Promise<unknown>;
	get_symbol_at_position(uri: vscode.Uri, position: Position, token?: CancellationToken): Promise<string | undefined>;
}

/** The native class index of the documentation provider. */
export interface NativeDocsIndex {
	readonly classInfo: Map<string, GodotNativeClassInfo>;
}

export interface DefinitionProviderOptions {
	languageService: LanguageService;
	/** Resolved per lookup: the documentation provider is created after this one. */
	docs?: () => NativeDocsIndex | undefined;
	/** Resolved per lookup: the connection manager replaces its client on reconnect. */
	lsp?: () => DefinitionLspClient | undefined;
}

/** A jump into the generated class documentation. */
function docLocation(path: string, fragment?: string): Location {
	return new vscode.Location(make_docs_uri(path, fragment), DOC_POSITION);
}

/** `var speed: int` / `func run()` -> the bare name. */
function normalizeNativeSymbolName(value: string): string {
	const normalized = value
		.trim()
		.replace(/\s*->\s*.*$/, "")
		.trim()
		.replace(/^func\s+/, "")
		.trim()
		.replace(/\s*\([^)]*\)\s*$/, "")
		.trim();

	// `bool is_empty()` keeps its return type; `operator ==(other)` does not.
	const typeMatch = normalized.match(/^([A-Za-z_][A-Za-z0-9_]*)\s+(.*)/);
	const withoutType = typeMatch && typeMatch[1] !== "operator" ? typeMatch[2].trim() : normalized;
	return withoutType.startsWith(".") ? withoutType.slice(1) : withoutType;
}

function splitNativeSymbolTarget(value: string): { className?: string; symbolName: string } {
	const normalized = value
		.trim()
		.replace(/^func\s+/, "")
		.replace(/\s*->\s*.*$/, "")
		.trim();
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
	return /^\s*\(/.test(document.getText().slice(document.offsetAt(range.end)));
}

function hasMemberReceiver(document: TextDocument, range: vscode.Range): boolean {
	const before = document.getText().slice(0, document.offsetAt(range.start));
	return /[A-Za-z_]\w*\.\s*$/.test(before) || /\.\s*$/.test(before);
}

function memberReceiver(
	document: TextDocument,
	range: vscode.Range | undefined,
): { name: string; range: vscode.Range } | undefined {
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

/**
 * The nearest `type="..."` attribute at or above `line`: scene files describe a
 * member on the line of the node it belongs to.
 */
function enclosingTypeAttribute(document: TextDocument, line: number): string | undefined {
	return Array.from({ length: line + 1 }, (_unused, index) => line - index)
		.map((lineNumber) => document.lineAt(lineNumber).text.match(TYPE_ATTRIBUTE_PATTERN)?.[1])
		.find((name) => name !== undefined);
}

/** The native class of a receiver, from the declaration of the receiver name. */
function receiverClassName(
	document: TextDocument,
	receiver: { name: string; range: vscode.Range },
	source: DefinitionProviderOptions,
	classInfo: Map<string, GodotNativeClassInfo>,
): string | undefined {
	if (classInfo.has(receiver.name)) return receiver.name;
	const type = source.languageService.types.resolveReceiver(
		document.uri.toString(),
		document.offsetAt(receiver.range.start),
		receiver.name,
	);
	return type?.builtin && classInfo.has(type.name) ? type.name : undefined;
}

async function nativeSymbolInfo(
	className: string,
	symbolName: string,
	token: CancellationToken,
	lsp: DefinitionLspClient | undefined,
): Promise<{ name?: string; kind?: string } | undefined> {
	if (!lsp || token.isCancellationRequested) return undefined;
	const params: NativeSymbolInspectParams = { native_class: className, symbol_name: symbolName };
	try {
		return (await lsp.sendRequest("textDocument/nativeSymbol", params, token)) as
			| { name?: string; kind?: string }
			| undefined;
	} catch {
		return undefined;
	}
}

async function nativeSymbolExists(
	className: string,
	symbolName: string,
	token: CancellationToken,
	lsp: DefinitionLspClient | undefined,
): Promise<boolean> {
	return (await nativeSymbolInfo(className, symbolName, token, lsp))?.name === symbolName;
}

/** The class whose documentation owns `symbolName`, walking up the bases. */
async function findMemberOwner(
	className: string,
	symbolName: string,
	token: CancellationToken,
	lsp: DefinitionLspClient | undefined,
	classInfo: Map<string, GodotNativeClassInfo>,
	visited: Set<string>,
): Promise<{ className: string; kind?: string } | undefined> {
	if (!className || visited.has(className) || token.isCancellationRequested) return undefined;
	visited.add(className);
	if (classInfo.has(className)) {
		const info = await nativeSymbolInfo(className, symbolName, token, lsp);
		if (info?.name === symbolName) return { className, kind: info.kind };
	}
	return findMemberOwner(classInfo.get(className)?.inherits ?? "", symbolName, token, lsp, classInfo, visited);
}

/** `extends X` and its bases, then the two builtin documentation classes. */
function nativeClassCandidates(document: TextDocument, classInfo: Map<string, GodotNativeClassInfo>): string[] {
	const extendsMatch = document.getText().match(EXTENDS_PATTERN);
	const inherited = extendsMatch ? classNameHierarchy(extendsMatch[1], classInfo) : [];
	return [...inherited, ...BUILTIN_DOCUMENTATION_CLASSES.filter((name) => !inherited.includes(name))];
}

function classNameHierarchy(className: string, classInfo: Map<string, GodotNativeClassInfo>): string[] {
	const walk = (current: string, seen: string[]): string[] =>
		!current || seen.includes(current)
			? []
			: [current, ...walk(classInfo.get(current)?.inherits ?? "", [...seen, current])];
	return walk(className, []);
}

/**
 * The first candidate that declares `symbolName`, answered by the engine. The
 * candidates are walked in order and a cancelled request stops the walk.
 */
async function firstDeclaringClass(
	candidates: readonly string[],
	symbolName: string,
	token: CancellationToken,
	lsp: DefinitionLspClient | undefined,
): Promise<string | undefined> {
	return candidates.reduce<Promise<string | undefined>>(async (previous, className) => {
		const found = await previous;
		if (found) return found;
		if (token.isCancellationRequested) return undefined;
		return (await nativeSymbolExists(className, symbolName, token, lsp)) ? className : undefined;
	}, Promise.resolve(undefined));
}

/** The `@GDScript`/`@GlobalScope` page that documents a builtin. */
async function builtinDocumentationClass(
	builtin: ResolvedBuiltinSymbol,
	token: CancellationToken,
	lsp: DefinitionLspClient | undefined,
): Promise<string> {
	const preferred = builtin.documentationClass;
	if (token.isCancellationRequested) return preferred;
	if (await nativeSymbolExists(preferred, builtin.builtin.name, token, lsp)) return preferred;
	const fallback = preferred === "@GDScript" ? "@GlobalScope" : "@GDScript";
	if (await nativeSymbolExists(fallback, builtin.builtin.name, token, lsp)) return fallback;
	return preferred;
}

/** The documentation of an engine member of a native receiver (`node.get_class()`). */
async function nativeMemberFromReceiver(
	document: TextDocument,
	range: vscode.Range,
	token: CancellationToken,
	source: DefinitionProviderOptions,
): Promise<Definition | undefined> {
	if (token.isCancellationRequested) return undefined;
	const receiver = memberReceiver(document, range);
	const classInfo = source.docs?.()?.classInfo;
	if (!receiver || !classInfo) return undefined;

	const className = receiverClassName(document, receiver, source, classInfo);
	if (!className) return undefined;
	const symbolName = document.getText(range);
	const owner = await findMemberOwner(className, symbolName, token, source.lsp?.(), classInfo, new Set<string>());
	if (!owner) return undefined;
	return docLocation(owner.className, doc_symbol_anchor(owner.kind, symbolName));
}

/** The documentation of a symbol the engine resolves through `textDocument/hover`. */
async function builtinSymbolDefinition(
	document: TextDocument,
	position: Position,
	token: CancellationToken,
	range: vscode.Range,
	source: DefinitionProviderOptions,
): Promise<Definition | undefined> {
	if (token.isCancellationRequested) return undefined;
	const classInfo = source.docs?.()?.classInfo;
	const target = await source.lsp?.()?.get_symbol_at_position(document.uri, position, token);
	if (!target) return undefined;

	const { className: explicitClassName, symbolName } = splitNativeSymbolTarget(target);
	if (!symbolName) return undefined;

	if (explicitClassName && classInfo?.has(explicitClassName)) {
		const owner = await findMemberOwner(
			explicitClassName,
			symbolName,
			token,
			source.lsp?.(),
			classInfo,
			new Set<string>(),
		);
		if (owner) return docLocation(owner.className, doc_symbol_anchor(owner.kind, symbolName));
	}
	const builtin = resolveBuiltinSymbol(symbolName);
	if (builtin) {
		const ownerClass = await builtinDocumentationClass(builtin, token, source.lsp?.());
		return docLocation(ownerClass, doc_symbol_anchor("method", builtin.builtin.name));
	}

	const receiver = memberReceiver(document, range);
	// A builtin member of a declared receiver, e.g. `var node: Node` then `node.foo`.
	if (receiver && classInfo) {
		const receiverClass = receiverClassName(document, receiver, source, classInfo);
		if (receiverClass) {
			const owner = await findMemberOwner(
				receiverClass,
				symbolName,
				token,
				source.lsp?.(),
				classInfo,
				new Set<string>(),
			);
			if (owner) return docLocation(owner.className, doc_symbol_anchor(owner.kind, symbolName));
		}
	}

	if (!classInfo) return undefined;
	const className = await firstDeclaringClass(
		nativeClassCandidates(document, classInfo),
		symbolName,
		token,
		source.lsp?.(),
	);
	if (!className) return undefined;
	const info = await nativeSymbolInfo(className, symbolName, token, source.lsp?.());
	return docLocation(className, doc_symbol_anchor(info?.kind, symbolName));
}

/** A class or property name of a scene file. */
function sceneDefinition(
	document: TextDocument,
	position: Position,
	source: DefinitionProviderOptions,
): Definition | undefined {
	const range = document.getWordRangeAtPosition(position, /(\w+)/);
	if (!range) return undefined;
	const word = document.getText(range);
	const classInfo = source.docs?.()?.classInfo;
	if (classInfo?.has(word)) return docLocation(word);

	const type = enclosingTypeAttribute(document, position.line);
	if (type && classInfo?.has(type)) return docLocation(type, doc_symbol_anchor("property", word));
	return undefined;
}

export type GDDefinitionProvider = DefinitionProvider;

export function createDefinitionProvider(
	context: ExtensionContext,
	source: DefinitionProviderOptions,
): GDDefinitionProvider {
	const provider: GDDefinitionProvider = {
		async provideDefinition(
			document: TextDocument,
			position: Position,
			token: CancellationToken,
		): Promise<Definition | undefined> {
			if (["gdresource", "gdscene"].includes(document.languageId))
				return sceneDefinition(document, position, source);

			const range = document.getWordRangeAtPosition(position, WORD_PATTERN);
			if (!range) return undefined;
			const functionCall = isFunctionCall(document, range);
			const memberAccess = hasMemberReceiver(document, range);
			const word = document.getText(range);

			// Engine members of a native receiver (`node.get_class()`) are documented
			// by Godot, not by the project index.
			if (memberAccess) {
				const nativeMember = await nativeMemberFromReceiver(document, range, token, source);
				if (nativeMember) return nativeMember;
			}

			// Project symbols come first: a script may declare a function, an inner
			// class or an inner class *method* whose name is also a builtin, and
			// Ctrl+Click must reach the declaration the project actually calls.
			const local = source.languageService.getLocalDefinition(document, position);
			if (local) return local;

			if (functionCall && !memberAccess) {
				const builtin = resolveBuiltinSymbol(word);
				if (builtin) {
					const ownerClass = await builtinDocumentationClass(builtin, token, source.lsp?.());
					return docLocation(ownerClass, doc_symbol_anchor("method", builtin.builtin.name));
				}
			}

			if (!functionCall && !memberAccess && source.docs?.()?.classInfo.has(word)) return docLocation(word);
			return builtinSymbolDefinition(document, position, token, range, source);
		},
	};
	context.subscriptions.push(vscode.languages.registerDefinitionProvider(RESOURCE_SELECTOR, provider));
	return provider;
}
