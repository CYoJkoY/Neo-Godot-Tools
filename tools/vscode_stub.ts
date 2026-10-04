/**
 * Minimal stand-in for the `vscode` module.
 *
 * The extension host provides this module at runtime. Unit tests run in plain
 * Node, so pure-TypeScript modules that merely *import* `vscode` must still be
 * loadable. Only the surface used by the local semantic pipeline and the
 * resource tooling is implemented; everything else is a deliberate no-op.
 *
 * The classes declare the members the extension actually reads or writes, plus
 * an `unknown` index signature so a test may attach extra fields without
 * falling back to `any`. `tools/vscode_stub_register.ts` makes
 * `require("vscode")` resolve here.
 */

import * as fs from "node:fs";
import * as path from "node:path";

/**
 * Repository root.
 *
 * The stub is compiled to `out-test/tools/vscode_stub.js`, so the repository
 * root is two directories up; tests that need fixture paths can override it
 * with `NEO_GODOT_TOOLS_TEST_EXTENSION_ROOT`.
 */
const EXTENSION_ROOT = process.env["NEO_GODOT_TOOLS_TEST_EXTENSION_ROOT"] || path.resolve(__dirname, "..", "..");

interface UriComponents {
	scheme?: string;
	authority?: string;
	path?: string;
	query?: string;
	fragment?: string;
}

class Uri {
	[key: string]: unknown;
	scheme: string;
	authority: string;
	path: string;
	query: string;
	fragment: string;

	constructor(scheme?: string, authority?: string, uriPath?: string, query?: string, fragment?: string) {
		this.scheme = scheme || "";
		this.authority = authority || "";
		this.path = uriPath || "";
		this.query = query || "";
		this.fragment = fragment || "";
	}

	/** File system path of a `file:` uri; other schemes keep their path. */
	get fsPath(): string {
		return this.path;
	}

	static file(value: string): Uri {
		return new Uri("file", "", value.replace(/\\/g, "/"), "", "");
	}

	static parse(value: string | { toString(): string }): Uri {
		const [rest, fragment] = splitOnce(String(value), "#");
		const schemeMatch = rest.match(/^([a-zA-Z][a-zA-Z0-9+.-]*):\/\//);
		if (!schemeMatch) return new Uri("file", "", rest, "", fragment);
		const withoutScheme = rest.slice(schemeMatch[0].length);
		const slash = withoutScheme.indexOf("/");
		return new Uri(
			schemeMatch[1],
			slash === -1 ? withoutScheme : withoutScheme.slice(0, slash),
			slash === -1 ? "" : withoutScheme.slice(slash),
			"",
			fragment,
		);
	}

	static from(components: UriComponents): Uri {
		return new Uri(components.scheme, components.authority, components.path, components.query, components.fragment);
	}

	static joinPath(base: Uri, ...segments: string[]): Uri {
		return Uri.file(path.join(base.path, ...segments));
	}

	toString(): string {
		const authority = this.authority ? `//${this.authority}` : "";
		const fragment = this.fragment ? `#${this.fragment}` : "";
		if (this.scheme === "file") return `file://${this.path}${fragment}`;
		return `${this.scheme}:${authority}${this.path}${fragment}`;
	}

	with(change: UriComponents): Uri {
		return new Uri(
			change.scheme ?? this.scheme,
			change.authority ?? this.authority,
			change.path ?? this.path,
			change.query ?? this.query,
			change.fragment ?? this.fragment,
		);
	}
}

function splitOnce(value: string, separator: string): [string, string] {
	const index = value.indexOf(separator);
	return index === -1 ? [value, ""] : [value.slice(0, index), value.slice(index + 1)];
}

class Position {
	[key: string]: unknown;
	constructor(
		public line: number,
		public character: number,
	) {}
}

class Range {
	[key: string]: unknown;
	start: Position;
	end: Position;

	constructor(
		startOrStartLine: Position | number,
		startCharacterOrEnd: Position | number,
		endLine = 0,
		endCharacter = 0,
	) {
		if (typeof startOrStartLine === "number") {
			this.start = new Position(startOrStartLine, Number(startCharacterOrEnd));
			this.end = new Position(endLine, endCharacter);
		} else {
			this.start = startOrStartLine;
			this.end = startCharacterOrEnd as Position;
		}
	}
}

class Selection extends Range {}

class Location {
	[key: string]: unknown;
	uri: Uri;
	range: Range;

	constructor(uri: Uri, rangeOrPosition: Range | Position) {
		this.uri = uri;
		this.range =
			rangeOrPosition instanceof Position ? new Range(rangeOrPosition, rangeOrPosition) : rangeOrPosition;
	}
}

class MarkdownString {
	[key: string]: unknown;
	value: string;
	isTrusted = false;
	supportHtml = false;

	constructor(value = "") {
		this.value = value;
	}

	appendMarkdown(value: string): this {
		this.value += value;
		return this;
	}

	appendCodeblock(value: string, language?: string): this {
		this.value += `\`\`\`${language}\n${value}\n\`\`\`\n`;
		return this;
	}

	appendText(value: string): this {
		this.value += value;
		return this;
	}
}

class Hover {
	[key: string]: unknown;
	contents: MarkdownString[];
	range?: Range;

	constructor(contents: MarkdownString | MarkdownString[], range?: Range) {
		this.contents = Array.isArray(contents) ? contents : [contents];
		this.range = range;
	}
}

class CompletionItem {
	[key: string]: unknown;
	label: string;
	kind?: number;
	detail?: string;
	documentation?: MarkdownString | string;
	insertText?: string;
	sortText?: string;
	filterText?: string;
	preselect?: boolean;
	textEdit?: unknown;
	additionalTextEdits?: unknown;
	commitCharacters?: string[];

	constructor(label: string, kind?: number) {
		this.label = label;
		this.kind = kind;
	}
}

class CompletionList {
	[key: string]: unknown;
	items: CompletionItem[];
	isIncomplete: boolean;

	constructor(items: CompletionItem[] = [], isIncomplete = false) {
		this.items = items;
		this.isIncomplete = isIncomplete;
	}
}

class SignatureInformation {
	[key: string]: unknown;
	parameters: ParameterInformation[] = [];

	constructor(
		public label: string,
		public documentation?: MarkdownString | string,
	) {}
}

class ParameterInformation {
	[key: string]: unknown;
	constructor(
		public label: string | [number, number],
		public documentation?: MarkdownString | string,
	) {}
}

class SignatureHelp {
	[key: string]: unknown;
	signatures: SignatureInformation[] = [];
	activeSignature = 0;
	activeParameter = 0;
}

class SymbolInformation {
	[key: string]: unknown;
	name: string;
	kind: number;
	location: Location;
	containerName?: string;

	constructor(name: string, kind: number, rangeOrLocation: Range | Location, uri?: Uri, containerName?: string) {
		this.name = name;
		this.kind = kind;
		this.location = uri ? new Location(uri, rangeOrLocation as Range) : (rangeOrLocation as Location);
		this.containerName = containerName;
	}
}

class TreeItem {
	[key: string]: unknown;
	label: string;
	collapsibleState?: number;
	contextValue = "";
	description?: string;
	tooltip?: MarkdownString | string;
	iconPath?: unknown;
	id?: string;

	constructor(label: string, collapsibleState?: number) {
		this.label = label;
		this.collapsibleState = collapsibleState;
	}
}

interface StubDisposable {
	dispose(): void;
}

class EventEmitter<T = unknown> {
	[key: string]: unknown;
	private listeners: Array<(value: T) => void> = [];

	event = (listener: (value: T) => void): StubDisposable => {
		this.listeners.push(listener);
		return { dispose: () => {} };
	};

	fire(value: T): void {
		for (const listener of this.listeners) listener(value);
	}

	dispose(): void {
		this.listeners = [];
	}
}

class Disposable {
	[key: string]: unknown;
	static from(...disposables: Array<{ dispose(): void } | undefined>): StubDisposable {
		return {
			dispose: () => {
				for (const disposable of disposables) disposable?.dispose();
			},
		};
	}

	dispose(): void {}
}

class TextEdit {
	[key: string]: unknown;
	static insert(position: Position, newText: string): TextEdit {
		return new TextEdit(new Range(position, position), newText);
	}

	constructor(
		public range: Range,
		public newText: string,
	) {}
}

/** Values mirror VS Code's `InlayHintKind`. */
const InlayHintKind = { Type: 1, Parameter: 2 };

class InlayHint {
	[key: string]: unknown;
	paddingLeft = false;
	paddingRight = false;
	textEdits?: TextEdit[];
	tooltip?: unknown;

	constructor(
		public position: Position,
		public label: string | unknown[],
		public kind?: number,
	) {}
}

class WorkspaceEdit {
	[key: string]: unknown;
	edits: Array<{ uri: Uri; range?: Range; newText?: string; edits?: unknown }> = [];

	replace(uri: Uri, range: Range, newText: string): void {
		this.edits.push({ uri, range, newText });
	}

	set(uri: Uri, edits: unknown): void {
		this.edits.push({ uri, edits });
	}
}

class RelativePattern {
	[key: string]: unknown;
	constructor(
		public base: string,
		public pattern: string,
	) {}
}

class ThemeColor {
	[key: string]: unknown;
	constructor(public id: string) {}
}

class Diagnostic {
	[key: string]: unknown;
	constructor(
		public range: Range,
		public message: string,
		public severity?: number,
	) {}
}

const event = (_listener: (...args: unknown[]) => unknown): StubDisposable => ({ dispose: () => {} });

/** Seed with `vscode.__configuration["neoGodotTools.some.setting"]` from a test. */
const configuration: Record<string, unknown> = {};

interface StubTextDocument {
	uri: Uri;
	languageId: string;
	version: number;
	getText(range?: Range): string;
	lineAt(lineOrPosition: number | Position): { text: string; lineNumber: number; range: Range };
	offsetAt(position: Position): number;
	positionAt(offset: number): Position;
	getWordRangeAtPosition(position: Position, regex?: RegExp): Range | undefined;
	position: Position;
	fileName: string;
	isUntitled: boolean;
	isDirty: boolean;
	isClosed: boolean;
}

const workspace = {
	textDocuments: [] as StubTextDocument[],
	workspaceFolders: [] as unknown[],
	getConfiguration: (section: string) => ({
		get: (key: string, fallback?: unknown): unknown => {
			const scoped = `${section}.${key}`;
			if (Object.prototype.hasOwnProperty.call(configuration, scoped)) return configuration[scoped];
			if (Object.prototype.hasOwnProperty.call(configuration, key)) return configuration[key];
			return fallback;
		},
		update: async (): Promise<void> => {},
		has: (): boolean => false,
	}),
	onDidOpenTextDocument: event,
	onDidChangeTextDocument: event,
	onDidSaveTextDocument: event,
	onDidCloseTextDocument: event,
	onDidChangeConfiguration: event,
	onDidChangeWorkspaceFolders: event,
	createFileSystemWatcher: () => ({
		onDidCreate: event,
		onDidChange: event,
		onDidDelete: event,
		dispose: () => {},
	}),
	findFiles: async (_include: string, _exclude?: string | null): Promise<Uri[]> => [],
	openTextDocument: async (uri: string | Uri): Promise<StubTextDocument> => {
		const resolved = typeof uri === "string" ? Uri.file(uri) : uri;
		return {
			uri: resolved,
			languageId: "gdscript",
			version: 1,
			getText: () => "",
			lineAt: () => ({ text: "", lineNumber: 0, range: new Range(0, 0) }),
			offsetAt: () => 0,
			positionAt: () => new Position(0, 0),
			getWordRangeAtPosition: () => undefined,
			position: new Position(0, 0),
			fileName: resolved.fsPath,
			isUntitled: false,
			isDirty: false,
			isClosed: false,
		};
	},
	applyEdit: async (_edit: WorkspaceEdit): Promise<boolean> => true,
	getWorkspaceFolder: (_uri: Uri) => undefined,
	asRelativePath: (value: string | Uri): string => String(value),
	fs: {
		readFile: async (uri: Uri): Promise<Uint8Array> => fs.promises.readFile(uri.fsPath),
		writeFile: async (uri: Uri, content: Uint8Array): Promise<void> => fs.promises.writeFile(uri.fsPath, content),
		stat: async (uri: Uri): Promise<fs.Stats> => fs.promises.stat(uri.fsPath),
	},
};

const window = {
	activeTextEditor: undefined as unknown,
	activeColorTheme: { kind: 1 },
	showInformationMessage: async (_message: string, ..._items: string[]): Promise<string | undefined> => undefined,
	showWarningMessage: async (_message: string, ..._items: string[]): Promise<string | undefined> => undefined,
	showErrorMessage: async (_message: string, ..._items: string[]): Promise<string | undefined> => undefined,
	showQuickPick: async (_items: unknown, _options?: unknown): Promise<unknown> => undefined,
	showInputBox: async (_options?: unknown): Promise<string | undefined> => undefined,
	showOpenDialog: async (_options?: unknown): Promise<Uri[] | undefined> => undefined,
	showTextDocument: async (_uri: Uri, _options?: unknown): Promise<unknown> => undefined,
	registerCustomEditorProvider: () => ({ dispose: () => {} }),
	registerWebviewViewProvider: () => ({ dispose: () => {} }),
	registerWebviewPanelSerializer: () => ({ dispose: () => {} }),
	createWebviewPanel: (_type: string, _title: string, _column?: number) => ({
		webview: { html: "", onDidReceiveMessage: event, postMessage: async () => true },
		onDidDispose: event,
		dispose: () => {},
	}),
	onDidChangeActiveTextEditor: event,
	onDidChangeVisibleTextEditors: event,
	onDidChangeActiveColorTheme: event,
	createOutputChannel: (_name: string, _options?: unknown) => ({
		appendLine: () => {},
		append: () => {},
		debug: () => {},
		info: () => {},
		warn: () => {},
		error: () => {},
		trace: () => {},
		show: () => {},
		dispose: () => {},
	}),
	createStatusBarItem: (_alignment?: number, _priority?: number) => ({
		show: () => {},
		hide: () => {},
		dispose: () => {},
		text: "",
		command: undefined as string | undefined,
		tooltip: undefined as string | undefined,
	}),
	withProgress: async (_options: unknown, task: (progress: unknown, token: unknown) => Promise<unknown>) =>
		task({ report: () => {} }, { isCancellationRequested: false }),
	visibleTextEditors: [] as unknown[],
};

const commands = {
	/** Registered handlers are kept so tests can invoke a command by id. */
	handlers: new Map<string, (...args: unknown[]) => unknown>(),
	registerCommand: (id: string, handler: (...args: unknown[]) => unknown) => {
		commands.handlers.set(id, handler);
		return { dispose: () => commands.handlers.delete(id) };
	},
	executeCommand: async (_command: string, ..._args: unknown[]): Promise<unknown> => undefined,
	getCommands: async (_filterInternal?: boolean): Promise<string[]> => [],
};

const languages = {
	createDiagnosticCollection: (name?: string) => {
		const entries = new Map<string, unknown>();
		return {
			name,
			set: (uri: Uri | string, diagnostics: unknown) => entries.set(String(uri), diagnostics),
			get: (uri: Uri | string) => entries.get(String(uri)),
			delete: (uri: Uri | string) => entries.delete(String(uri)),
			clear: () => entries.clear(),
			forEach: (callback: (diagnostics: unknown, uri: string) => void) => entries.forEach(callback),
			dispose: () => entries.clear(),
			__entries: entries,
		};
	},
	registerCompletionItemProvider: () => ({ dispose: () => {} }),
	registerDefinitionProvider: () => ({ dispose: () => {} }),
	registerHoverProvider: () => ({ dispose: () => {} }),
	registerDocumentSymbolProvider: () => ({ dispose: () => {} }),
	registerWorkspaceSymbolProvider: () => ({ dispose: () => {} }),
	registerReferenceProvider: () => ({ dispose: () => {} }),
	registerRenameProvider: () => ({ dispose: () => {} }),
	registerSignatureHelpProvider: () => ({ dispose: () => {} }),
	registerDocumentLinkProvider: () => ({ dispose: () => {} }),
	registerDocumentDropEditProvider: () => ({ dispose: () => {} }),
	registerDocumentFormattingEditProvider: () => ({ dispose: () => {} }),
	registerDocumentRangeFormattingEditProvider: () => ({ dispose: () => {} }),
	registerDocumentSemanticTokensProvider: () => ({ dispose: () => {} }),
	registerInlayHintsProvider: () => ({ dispose: () => {} }),
	match: (_selector: unknown, _document: unknown): number => 0,
	setLanguageConfiguration: () => ({ dispose: () => {} }),
};

const extensions = {
	getExtension: (id: string) => ({
		id,
		extensionUri: Uri.file(EXTENSION_ROOT),
		extensionPath: EXTENSION_ROOT,
		isActive: true,
		exports: undefined as unknown,
		activate: async (): Promise<unknown> => undefined,
	}),
	all: [] as unknown[],
};

const env = {
	appName: "VS Code",
	language: "en",
	clipboard: { writeText: async (_value: string): Promise<void> => {}, readText: async (): Promise<string> => "" },
	openExternal: async (_uri: Uri): Promise<boolean> => true,
};

const debug = {
	activeDebugSession: undefined as unknown,
	activeStackItem: undefined as unknown,
	onDidChangeActiveStackItem: event,
	onDidChangeActiveDebugSession: event,
	onDidReceiveDebugSessionCustomEvent: event,
	startDebugging: async (_folder: unknown, _nameOrConfig: unknown): Promise<boolean> => true,
	registerDebugAdapterDescriptorFactory: () => ({ dispose: () => {} }),
	registerDebugConfigurationProvider: () => ({ dispose: () => {} }),
};

const tasks = {
	registerTaskProvider: () => ({ dispose: () => {} }),
};

const tests = {};

const ColorThemeKind = { Light: 1, Dark: 2, HighContrast: 3, HighContrastLight: 4 };

const CompletionItemKind = {
	Text: 0,
	Method: 1,
	Function: 2,
	Constructor: 3,
	Field: 4,
	Variable: 5,
	Class: 6,
	Interface: 7,
	Module: 8,
	Property: 9,
	Unit: 10,
	Value: 11,
	Enum: 12,
	Keyword: 13,
	Snippet: 14,
	Color: 15,
	File: 16,
	Reference: 17,
	Folder: 18,
	EnumMember: 19,
	Constant: 20,
	Struct: 21,
	Event: 22,
	Operator: 23,
	TypeParameter: 24,
};

const SymbolKind = {
	File: 0,
	Module: 1,
	Namespace: 2,
	Package: 3,
	Class: 4,
	Method: 5,
	Property: 6,
	Field: 7,
	Constructor: 8,
	Enum: 9,
	Interface: 10,
	Function: 11,
	Variable: 12,
	Constant: 13,
	String: 14,
	Number: 15,
	Boolean: 16,
	Array: 17,
	Object: 18,
	Key: 19,
	Null: 20,
	EnumMember: 21,
	Struct: 22,
	Event: 23,
	Operator: 24,
	TypeParameter: 25,
};

const TreeItemCollapsibleState = { None: 0, Collapsed: 1, Expanded: 2 };

const StatusBarAlignment = { Left: 1, Right: 2 };

const ViewColumn = { Active: -1, Beside: -2, One: 1, Two: 2, Three: 3 };

const FileType = { Unknown: 0, File: 1, Directory: 2, SymbolicLink: 64 };

const ProgressLocation = { SourceControl: 1, Window: 10, Notification: 15 };

const ConfigurationTarget = { Global: 1, Workspace: 2, WorkspaceFolder: 3 };

const DiagnosticSeverity = { Error: 0, Warning: 1, Information: 2, Hint: 3 };

const UIKind = { Desktop: 1, Web: 2 };

const version = "1.96.0";
const __stub = true;
const __configuration = configuration;

export {
	Uri,
	Position,
	Range,
	Selection,
	Location,
	MarkdownString,
	Hover,
	CompletionItem,
	CompletionList,
	SignatureInformation,
	ParameterInformation,
	SignatureHelp,
	SymbolInformation,
	TreeItem,
	EventEmitter,
	Disposable,
	WorkspaceEdit,
	TextEdit,
	InlayHint,
	InlayHintKind,
	RelativePattern,
	ThemeColor,
	workspace,
	window,
	commands,
	languages,
	extensions,
	env,
	debug,
	tasks,
	tests,
	ColorThemeKind,
	CompletionItemKind,
	SymbolKind,
	TreeItemCollapsibleState,
	StatusBarAlignment,
	ViewColumn,
	FileType,
	ProgressLocation,
	ConfigurationTarget,
	UIKind,
	version,
	Diagnostic,
	DiagnosticSeverity,
	__stub,
	__configuration,
};
export type { StubDisposable, StubTextDocument, UriComponents };
