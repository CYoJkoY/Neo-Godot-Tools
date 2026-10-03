/**
 * Minimal stand-in for the `vscode` module.
 *
 * The extension host provides this module at runtime. Unit tests run in plain
 * Node, so pure-TypeScript modules that merely *import* `vscode` must still be
 * loadable. Only the surface used by the local semantic pipeline and the
 * resource tooling is implemented; everything else is a deliberate no-op.
 *
 * `tools/vscode_stub_register.ts` makes `require("vscode")` resolve here.
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
const EXTENSION_ROOT = process.env.NEO_GODOT_TOOLS_TEST_EXTENSION_ROOT || path.resolve(__dirname, "..", "..");

class Uri {
	[key: string]: any;
	constructor(scheme, authority, uriPath, query, fragment) {
		this.scheme = scheme || "";
		this.authority = authority || "";
		this.path = uriPath || "";
		this.query = query || "";
		this.fragment = fragment || "";
	}

	static file(value) {
		return new Uri("file", "", value.replace(/\\/g, "/"), "", "");
	}

	static parse(value) {
		const [rest, fragment] = splitOnce(String(value), "#");
		const schemeMatch = rest.match(/^([a-zA-Z][a-zA-Z0-9+.-]*):\/\//);
		if (schemeMatch) {
			const withoutScheme = rest.slice(schemeMatch[0].length);
			const slash = withoutScheme.indexOf("/");
			const authority = slash === -1 ? withoutScheme : withoutScheme.slice(0, slash);
			const uriPath = slash === -1 ? "" : withoutScheme.slice(slash);
			return new Uri(schemeMatch[1], authority, uriPath, "", fragment);
		}
		return new Uri("file", "", rest, "", fragment);
	}

	static from(components) {
		// `fsPath` is derived from `path` by the prototype getter below.
		return new Uri(components.scheme, components.authority, components.path, components.query, components.fragment);
	}

	static joinPath(base, ...segments) {
		return Uri.file(path.join(base.fsPath ?? base.path, ...segments));
	}

	toString() {
		const authority = this.authority ? `//${this.authority}` : "";
		const fragment = this.fragment ? `#${this.fragment}` : "";
		if (this.scheme === "file") return `file://${this.path}${fragment}`;
		return `${this.scheme}:${authority}${this.path}${fragment}`;
	}

	with(change) {
		return new Uri(
			change.scheme ?? this.scheme,
			change.authority ?? this.authority,
			change.path ?? this.path,
			change.query ?? this.query,
			change.fragment ?? this.fragment,
		);
	}
}

Object.defineProperty(Uri.prototype, "fsPath", {
	get() {
		return this.path;
	},
	configurable: true,
});

function splitOnce(value, separator) {
	const index = value.indexOf(separator);
	return index === -1 ? [value, ""] : [value.slice(0, index), value.slice(index + 1)];
}

class Position {
	[key: string]: any;
	constructor(line, character) {
		this.line = line;
		this.character = character;
	}
}

class Range {
	[key: string]: any;
	constructor(startOrStartLine, startCharacterOrEnd, endLine = 0, endCharacter = 0) {
		if (typeof startOrStartLine === "number") {
			this.start = new Position(startOrStartLine, startCharacterOrEnd);
			this.end = new Position(endLine, endCharacter);
		} else {
			this.start = startOrStartLine;
			this.end = startCharacterOrEnd;
		}
	}
}

class Selection extends Range {}

class Location {
	[key: string]: any;
	constructor(uri, rangeOrPosition) {
		this.uri = uri;
		this.range =
			rangeOrPosition instanceof Position ? new Range(rangeOrPosition, rangeOrPosition) : rangeOrPosition;
	}
}

class MarkdownString {
	[key: string]: any;
	constructor(value = "") {
		this.value = value;
		this.isTrusted = false;
		this.supportHtml = false;
	}

	appendMarkdown(value) {
		this.value += value;
		return this;
	}

	appendCodeblock(value, language) {
		this.value += `\`\`\`${language}\n${value}\n\`\`\`\n`;
		return this;
	}

	appendText(value) {
		this.value += value;
		return this;
	}
}

class Hover {
	[key: string]: any;
	constructor(contents, range) {
		this.contents = Array.isArray(contents) ? contents : [contents];
		this.range = range;
	}
}

class CompletionItem {
	[key: string]: any;
	constructor(label, kind) {
		this.label = label;
		this.kind = kind;
	}
}

class CompletionList {
	[key: string]: any;
	constructor(items, isIncomplete) {
		this.items = items ?? [];
		this.isIncomplete = !!isIncomplete;
	}
}

class SignatureInformation {
	[key: string]: any;
	constructor(label, documentation) {
		this.label = label;
		this.documentation = documentation;
		this.parameters = [];
	}
}

class ParameterInformation {
	[key: string]: any;
	constructor(label, documentation) {
		this.label = label;
		this.documentation = documentation;
	}
}

class SignatureHelp {
	[key: string]: any;
	constructor() {
		this.signatures = [];
		this.activeSignature = 0;
		this.activeParameter = 0;
	}
}

class SymbolInformation {
	[key: string]: any;
	constructor(name, kind, rangeOrLocation, uri, containerName) {
		this.name = name;
		this.kind = kind;
		this.location = uri ? new Location(uri, rangeOrLocation) : rangeOrLocation;
		this.containerName = containerName;
	}
}

class TreeItem {
	[key: string]: any;
	constructor(label, collapsibleState) {
		this.label = label;
		this.collapsibleState = collapsibleState;
		this.contextValue = "";
	}
}

class EventEmitter {
	[key: string]: any;
	constructor() {
		this.listeners = [];
		this.event = (listener) => {
			this.listeners.push(listener);
			return { dispose: () => {} };
		};
	}

	fire(value) {
		for (const listener of this.listeners) listener(value);
	}

	dispose() {}
}

class Disposable {
	[key: string]: any;
	static from(...disposables) {
		return {
			dispose: () => {
				for (const disposable of disposables) disposable?.dispose?.();
			},
		};
	}

	dispose() {}
}

class WorkspaceEdit {
	[key: string]: any;
	constructor() {
		this.edits = [];
	}

	replace(uri, range, newText) {
		this.edits.push({ uri, range, newText });
	}

	set(uri, edits) {
		this.edits.push({ uri, edits });
	}
}

class RelativePattern {
	[key: string]: any;
	constructor(base, pattern) {
		this.base = base;
		this.pattern = pattern;
	}
}

class ThemeColor {
	[key: string]: any;
	constructor(id) {
		this.id = id;
	}
}

const event = (_listener) => ({ dispose: () => {} });

// Tests can seed this with `vscode.__configuration["neoGodotTools.some.setting"]`.
const configuration = {};

const workspace = {
	textDocuments: [],
	workspaceFolders: [],
	getConfiguration: (section) => ({
		get: (key, fallback) => {
			const scoped = `${section}.${key}`;
			if (Object.prototype.hasOwnProperty.call(configuration, scoped)) return configuration[scoped];
			if (Object.prototype.hasOwnProperty.call(configuration, key)) return configuration[key];
			return fallback;
		},
		update: async () => {},
		has: () => false,
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
	findFiles: async () => [],
	openTextDocument: async (uri) => ({
		uri: typeof uri === "string" ? Uri.file(uri) : uri,
		languageId: "gdscript",
		version: 1,
		getText: () => "",
		lineAt: () => ({ text: "", lineNumber: 0 }),
		offsetAt: () => 0,
		positionAt: () => new Position(0, 0),
		getWordRangeAtPosition: () => undefined,
	}),
	applyEdit: async () => true,
	getWorkspaceFolder: () => undefined,
	asRelativePath: (value) => String(value),
	fs: {
		readFile: async (uri) => fs.promises.readFile(uri.fsPath ?? uri.path),
		writeFile: async (uri, content) => fs.promises.writeFile(uri.fsPath ?? uri.path, content),
		stat: async (uri) => fs.promises.stat(uri.fsPath ?? uri.path),
	},
};

const window = {
	activeTextEditor: undefined,
	activeColorTheme: { kind: 1 },
	showInformationMessage: async () => undefined,
	showWarningMessage: async () => undefined,
	showErrorMessage: async () => undefined,
	showQuickPick: async () => undefined,
	showInputBox: async () => undefined,
	showOpenDialog: async () => undefined,
	showTextDocument: async () => undefined,
	registerCustomEditorProvider: () => ({ dispose: () => {} }),
	registerWebviewViewProvider: () => ({ dispose: () => {} }),
	registerWebviewPanelSerializer: () => ({ dispose: () => {} }),
	createWebviewPanel: () => ({
		webview: { html: "", onDidReceiveMessage: event, postMessage: async () => true },
		onDidDispose: event,
		dispose: () => {},
	}),
	onDidChangeActiveTextEditor: event,
	onDidChangeVisibleTextEditors: event,
	onDidChangeActiveColorTheme: event,
	createOutputChannel: () => ({ appendLine: () => {}, append: () => {}, show: () => {}, dispose: () => {} }),
	createStatusBarItem: () => ({
		show: () => {},
		hide: () => {},
		dispose: () => {},
		text: "",
		command: undefined,
		tooltip: undefined,
	}),
	withProgress: async (_options, task) => task({ report: () => {} }, { isCancellationRequested: false }),
	visibleTextEditors: [],
};

const commands = {
	registerCommand: () => ({ dispose: () => {} }),
	executeCommand: async () => undefined,
	getCommands: async () => [],
};

const languages = {
	createDiagnosticCollection: (name) => {
		const entries = new Map();
		return {
			name,
			set: (uri, diagnostics) => entries.set(String(uri), diagnostics),
			get: (uri) => entries.get(String(uri)),
			delete: (uri) => entries.delete(String(uri)),
			clear: () => entries.clear(),
			forEach: (callback) => entries.forEach(callback),
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
	match: () => 0,
	setLanguageConfiguration: () => ({ dispose: () => {} }),
};

const extensions = {
	getExtension: (id) => ({
		id,
		extensionUri: Uri.file(EXTENSION_ROOT),
		extensionPath: EXTENSION_ROOT,
		isActive: true,
		exports: undefined,
		activate: async () => undefined,
	}),
	all: [],
};

const env = {
	appName: "VS Code",
	language: "en",
	clipboard: { writeText: async () => {}, readText: async () => "" },
	openExternal: async () => true,
};

const debug = {
	activeDebugSession: undefined,
	activeStackItem: undefined,
	onDidChangeActiveStackItem: event,
	onDidChangeActiveDebugSession: event,
	onDidReceiveDebugSessionCustomEvent: event,
	startDebugging: async () => true,
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

class Diagnostic {
	[key: string]: any;
	constructor(range, message, severity) {
		this.range = range;
		this.message = message;
		this.severity = severity;
	}
}

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
