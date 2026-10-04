import * as vscode from "vscode";
import type {
	CancellationToken,
	CustomDocument,
	CustomDocumentOpenContext,
	CustomReadonlyEditorProvider,
	ExtensionContext,
	Uri,
	Webview,
	WebviewPanel,
} from "vscode";
import type { NotificationMessage } from "vscode-jsonrpc";
import type { LspClientLike } from "../lsp/types";
import { get_configuration, get_extension_uri, make_docs_uri } from "../utils";
import { make_html_content } from "./documentation_builder";
import type {
	GodotCapabilities,
	GodotNativeClassInfo,
	GodotNativeSymbol,
	NativeSymbolInspectParams,
} from "./documentation_types";

/** Placeholder for a base class the engine did not report itself. */
function placeholderClass(name: string): GodotNativeClassInfo {
	return { name, inherits: "" };
}

/**
 * Adds a copy of `gdclass` to the index and records it as an extension of its
 * base class, creating the base entry when the engine only reported the subclass.
 *
 * The entries are copied because the same objects are the capabilities message
 * of the client: the previous revision appended to their `extended_classes` in
 * place, so the index edited the message it was built from.
 */
function addToBase(classInfo: Map<string, GodotNativeClassInfo>, gdclass: GodotNativeClassInfo): void {
	// Copy the entry and its extended list: they belong to the client's message.
	const entry: GodotNativeClassInfo = { ...gdclass };
	if (gdclass.extended_classes) entry.extended_classes = [...gdclass.extended_classes];
	classInfo.set(entry.name, entry);
	if (!entry.inherits) return;
	if (!classInfo.has(entry.inherits)) classInfo.set(entry.inherits, placeholderClass(entry.inherits));
	const base = classInfo.get(entry.inherits);
	if (base) base.extended_classes = [...(base.extended_classes ?? []), entry.name];
}

function documentClass(uri: Uri): string {
	return uri.path.split(".")[0];
}

export interface GDDocumentationProvider extends CustomReadonlyEditorProvider {
	/** Native class index, filled from `gdscript/capabilities`. */
	readonly classInfo: Map<string, GodotNativeClassInfo>;
	/** Requested `textDocument/nativeSymbol` results, keyed by class name. */
	readonly symbolDb: Map<string, GodotNativeSymbol>;
	register_capabilities(message: NotificationMessage): void;
	list_native_classes(): Promise<void>;
}

export interface DocumentationOptions {
	/** Resolved on every request: the connection manager replaces its client on reconnect. */
	lsp?: () => LspClientLike | undefined;
}

export function createDocumentationProvider(
	context: ExtensionContext,
	options: DocumentationOptions = {},
): GDDocumentationProvider {
	const lsp = options.lsp ?? (() => undefined);
	const classInfo = new Map<string, GodotNativeClassInfo>();
	const symbolDb = new Map<string, GodotNativeSymbol>();
	const htmlDb = new Map<string, string>();
	const capabilities = { ready: false, notify: undefined as (() => void) | undefined };

	/** Resolves when `gdscript/capabilities` arrives, or when the editor is closed. */
	const waitForCapabilities = (token: CancellationToken): Promise<void> => {
		if (capabilities.ready) return Promise.resolve();
		const ready = new Promise<void>((resolve) => {
			capabilities.notify = resolve;
		});
		const cancelled = new Promise<void>((resolve) => token.onCancellationRequested(resolve));
		return Promise.race([ready, cancelled]);
	};

	/** The class documentation of the engine's `nativeSymbol` request. */
	const requestSymbol = async (className: string): Promise<GodotNativeSymbol | undefined> => {
		const params: NativeSymbolInspectParams = { native_class: className, symbol_name: className };
		const response = await lsp()?.sendRequest("textDocument/nativeSymbol", params);
		if (!response) return undefined;
		const symbol = response as GodotNativeSymbol;
		symbol.class_info = classInfo.get(symbol.name);
		symbolDb.set(symbol.name, symbol);
		return symbol;
	};

	const loadHtml = async (className: string, webview: Webview, target: string): Promise<string | undefined> => {
		const cached = symbolDb.get(className);
		// The engine can only resolve classes it announced as capabilities.
		const symbol = cached ?? (classInfo.has(className) ? await requestSymbol(className) : undefined);
		if (symbol && !htmlDb.has(className)) htmlDb.set(className, make_html_content(webview, symbol, target));
		return htmlDb.get(className);
	};

	/** Applies the user settings and the fragment focus to a cached page. */
	const renderHtml = (html: string, target: string): string => {
		const scaleFactor = get_configuration("documentation.pageScale", 100);
		const minimap = get_configuration("documentation.displayMinimap");
		const scaled = html
			.replaceAll("scaleFactor", String(scaleFactor))
			.replace("displayMinimap", minimap ? "initial;" : "none;")
			.replace("bodyMargin", minimap ? "200px;" : "0px;");
		if (!target) return scaled;
		// The generated page exposes `ngdtFocus`; calling it here also covers cached
		// pages that were rendered before the target was known.
		return scaled.replace(
			"</body>",
			`<script>if (typeof ngdtFocus === "function") ngdtFocus(${JSON.stringify(target)});</script></body>`,
		);
	};

	const provider: GDDocumentationProvider = {
		classInfo,
		symbolDb,
		register_capabilities(message: NotificationMessage): void {
			(message.params as GodotCapabilities).native_classes.map((gdclass) => addToBase(classInfo, gdclass));
			capabilities.ready = true;
			capabilities.notify?.();
		},
		async list_native_classes(): Promise<void> {
			const classname = await vscode.window.showQuickPick([...classInfo.keys()].sort(), {
				placeHolder: "Type godot class name here",
				canPickMany: false,
			});
			if (classname) await vscode.commands.executeCommand("vscode.open", make_docs_uri(classname));
		},
		openCustomDocument(
			uri: Uri,
			_openContext: CustomDocumentOpenContext,
			_token: CancellationToken,
		): CustomDocument {
			return { uri, dispose: () => {} };
		},
		async resolveCustomEditor(
			document: CustomDocument,
			panel: WebviewPanel,
			token: CancellationToken,
		): Promise<void> {
			const className = documentClass(document.uri);
			const target = document.uri.fragment;
			panel.webview.options = { enableScripts: true };
			await waitForCapabilities(token);

			const classHtml = await loadHtml(className, panel.webview, target);
			if (classHtml) panel.webview.html = renderHtml(classHtml, target);

			panel.iconPath = get_extension_uri("resources/godot_icon.svg");
			panel.webview.onDidReceiveMessage((msg) => {
				if (msg.type !== "INSPECT_NATIVE_SYMBOL") return;
				const uri = make_docs_uri(msg.data.native_class, msg.data.symbol_name);
				vscode.commands.executeCommand("vscode.open", uri);
			});
			if (target) panel.webview.postMessage({ command: "focus", target });
		},
	};

	context.subscriptions.push(
		vscode.window.registerCustomEditorProvider("gddoc", provider, {
			// `enableScripts` is not part of `WebviewPanelOptions`: scripts are enabled
			// on the panel's own `webview.options` in `resolveCustomEditor`.
			webviewOptions: {
				retainContextWhenHidden: true,
				enableFindWidget: true,
			},
			supportsMultipleEditorsPerDocument: true,
		}),
	);
	return provider;
}
