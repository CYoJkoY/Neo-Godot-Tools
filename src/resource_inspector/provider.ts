/**
 * Resource Inspector — a Godot-like inspector for `.tres` files.
 *
 * The same provider backs both entry points requested by the feature:
 *  - `CustomTextEditorProvider` (editor tab, `Open With... > Resource Inspector`),
 *  - `WebviewViewProvider` (the "Resource Inspector" side panel).
 *
 * All edits are written through `WorkspaceEdit` so the raw text document stays
 * the source of truth and `Open With... > Text Editor` keeps working.
 */

import * as fs from "node:fs";
import * as path from "node:path";
import * as vscode from "vscode";
import {
	applyResourceEdits,
	PropertyEntry,
	ResourceDocument,
	ResourceEdit,
	parseResourceDocument,
} from "./document.js";
import { collectPropertyMetadata, LspPropertyInfo, PropertyMetadata, widgetForProperty } from "./metadata.js";
import { validateResourceDocument } from "./diagnostics.js";
import { formatVariant, parseVariant } from "./values.js";

export const RESOURCE_INSPECTOR_VIEW_TYPE = "neoGodotTools.resourceInspector";
export const RESOURCE_INSPECTOR_VIEW_ID = "neoGodotTools.resourceInspector";
const RESOURCE_INSPECTOR_DIAGNOSTICS_SETTING = "neoGodotTools.resource.inspector.diagnostics";

interface PropertyModel {
	name: string;
	valueText: string;
	raw: string;
	/** Sub-resource the property belongs to, if any. */
	target?: string;
	metadata?: PropertyMetadata;
	widget: ReturnType<typeof widgetForProperty>;
}

interface ResourceModel {
	uri: string;
	version: number;
	resourceType: string;
	scriptClass?: string;
	format?: string;
	uid?: string;
	properties: PropertyModel[];
	subResourceTypes: Array<{ id: string; type: string }>;
	subResources: Array<{ id: string; type: string; properties: PropertyModel[] }>;
	extResources: Array<{ id: string; type: string; path?: string; uid?: string; broken: boolean }>;
	diagnostics: Array<{ message: string; severity: "error" | "warning"; line: number }>;
	openIn: string;
}

const SCRIPT_PROPERTY = "script";

export class ResourceInspectorProvider implements vscode.CustomTextEditorProvider, vscode.WebviewViewProvider {
	private readonly diagnostics = vscode.languages.createDiagnosticCollection("neoGodotTools.resourceInspector");
	private readonly editors = new Map<string, Set<vscode.WebviewPanel>>();
	private readonly syncedVersions = new Map<string, number>();
	private view?: vscode.WebviewView;
	private panelUri?: vscode.Uri;

	constructor(private readonly context: vscode.ExtensionContext) {
		this.context.subscriptions.push(
			vscode.window.registerCustomEditorProvider(RESOURCE_INSPECTOR_VIEW_TYPE, this, {
				webviewOptions: { retainContextWhenHidden: true },
				supportsMultipleEditorsPerDocument: true,
			}),
			vscode.window.registerWebviewViewProvider(RESOURCE_INSPECTOR_VIEW_ID, this, {
				webviewOptions: { retainContextWhenHidden: true },
			}),
			vscode.workspace.onDidChangeTextDocument((event) => void this.onDocumentChanged(event)),
			vscode.workspace.onDidOpenTextDocument((document) => void this.onDocumentOpened(document)),
			vscode.workspace.onDidChangeConfiguration((event) => {
				if (!event.affectsConfiguration(RESOURCE_INSPECTOR_DIAGNOSTICS_SETTING)) return;
				// Turning validation off must also take back what it reported.
				if (!diagnosticsEnabled()) this.diagnostics.clear();
			}),
			this.diagnostics,
		);
	}

	// ------------------------------------------------------------------ commands

	/** `Godot Tools: Open Resource Inspector` and the explorer context menu. */
	async openResourceInspector(uri?: vscode.Uri): Promise<void> {
		const target = uri ?? vscode.window.activeTextEditor?.document.uri;
		if (!target) {
			void vscode.window.showWarningMessage("Open a .tres file first, or run the command from the explorer.");
			return;
		}
		if (getOpenIn() === "panel") {
			await vscode.commands.executeCommand(`${RESOURCE_INSPECTOR_VIEW_ID}.focus`);
			this.panelUri = target;
			await this.refreshView();
			return;
		}
		await vscode.commands.executeCommand("vscode.openWith", target, RESOURCE_INSPECTOR_VIEW_TYPE);
	}

	// ------------------------------------------------------- custom text editor

	async resolveCustomTextEditor(document: vscode.TextDocument, panel: vscode.WebviewPanel): Promise<void> {
		const key = document.uri.toString();
		const editors = this.editors.get(key) ?? new Set<vscode.WebviewPanel>();
		editors.add(panel);
		this.editors.set(key, editors);

		panel.webview.options = { enableScripts: true };
		panel.webview.html = await this.html(panel.webview);
		this.panelUri = document.uri;
		void this.reloadDocument(document.uri, panel.webview, true);

		panel.webview.onDidReceiveMessage((message) => void this.onMessage(document.uri, message, panel));
		panel.onDidDispose(() => {
			editors.delete(panel);
			if (!editors.size) this.editors.delete(key);
		});
		panel.onDidChangeViewState(() => {
			if (panel.active) void this.reloadDocument(document.uri, panel.webview, true);
		});
	}

	// ------------------------------------------------------------- webview view

	async resolveWebviewView(view: vscode.WebviewView): Promise<void> {
		this.view = view;
		view.webview.options = { enableScripts: true };
		view.webview.html = await this.html(view.webview);
		view.webview.onDidReceiveMessage((message) => {
			const uri = this.panelUri ?? vscode.window.activeTextEditor?.document.uri;
			if (uri) void this.onMessage(uri, message);
		});
		view.onDidChangeVisibility(() => {
			if (view.visible) void this.refreshView();
		});
		await this.refreshView();
	}

	private async refreshView(): Promise<void> {
		if (!this.view) return;
		const document = await this.currentDocument();
		if (!document) {
			void this.view.webview.postMessage({ type: "empty" });
			return;
		}
		this.panelUri = document.uri;
		await this.sendModel(document, this.view.webview);
	}

	private async currentDocument(): Promise<vscode.TextDocument | undefined> {
		if (this.panelUri && isResourceFile(this.panelUri)) {
			try {
				return await vscode.workspace.openTextDocument(this.panelUri);
			} catch {
				/* fall through to the active editor */
			}
		}
		const active = vscode.window.activeTextEditor?.document;
		if (active && isResourceFile(active.uri)) return active;
		return undefined;
	}

	// -------------------------------------------------------------- messaging

	private async onMessage(uri: vscode.Uri, message: { command?: string; [key: string]: unknown }, panel?: vscode.WebviewPanel): Promise<void> {
		switch (message.command) {
			case "ready":
			case "reload":
				await this.reloadDocument(uri, panel ? panel.webview : this.view?.webview, true);
				return;
			case "keepChanges":
				await this.reloadDocument(uri, panel ? panel.webview : this.view?.webview, false);
				return;
			case "openText":
				await vscode.commands.executeCommand("vscode.openWith", uri, "default");
				return;
			case "openExtResource": {
				await this.openExtResource(uri, String(message.id ?? ""));
				return;
			}
			case "setProperty": {
				const name = String(message.name ?? "");
				const value = String(message.value ?? "");
				await this.applyEdits(uri, [{ kind: "setProperty", name, value, target: message.target as string | undefined }]);
				return;
			}
			case "revertProperty": {
				const name = String(message.name ?? "");
				await this.applyEdits(uri, [{ kind: "revertProperty", name, target: message.target as string | undefined, defaultValue: message.defaultValue as string | undefined }]);
				return;
			}
			case "addSubResource": {
				await this.applyEdits(uri, [{ kind: "addSubResource", type: String(message.subType ?? "Resource") }]);
				return;
			}
			case "duplicateSubResource": {
				await this.applyEdits(uri, [{ kind: "duplicateSubResource", id: String(message.id ?? "") }]);
				return;
			}
			case "deleteSubResource": {
				await this.applyEdits(uri, [{ kind: "deleteSubResource", id: String(message.id ?? "") }]);
				return;
			}
			case "renameSubResource": {
				await this.applyEdits(uri, [{ kind: "renameSubResource", id: String(message.id ?? ""), newId: String(message.newId ?? "") }]);
				return;
			}
			case "pickResource": {
				await this.pickResource(uri, String(message.name ?? ""), message.target as string | undefined);
				return;
			}
			case "createSubResource": {
				await this.createSubResource(uri, String(message.name ?? ""), String(message.subType ?? message.metaType ?? "Resource"), message.target as string | undefined);
				return;
			}
			default:
				return;
		}
	}

	private async openExtResource(uri: vscode.Uri, id: string): Promise<void> {
		const document = await vscode.workspace.openTextDocument(uri);
		const resource = parseResourceDocument(document.getText()).extResources.find((entry) => entry.id === id);
		if (!resource?.path) {
			void vscode.window.showWarningMessage(`ExtResource '${id}' has no path.`);
			return;
		}
		const target = resolveResourceUri(uri, resource.path);
		if (!target) {
			void vscode.window.showWarningMessage(`Unable to resolve '${resource.path}'.`);
			return;
		}
		try {
			await vscode.workspace.fs.stat(target);
		} catch {
			void vscode.window.showWarningMessage(`'${resource.path}' no longer exists.`);
			return;
		}
		await vscode.commands.executeCommand("vscode.open", target);
	}

	/** Opens a `.tres` as an `ExtResource` for the selected property. */
	private async pickResource(uri: vscode.Uri, propertyName: string, target?: string): Promise<void> {
		const picked = await vscode.window.showOpenDialog({
			canSelectMany: false,
			filters: { "Godot resources": ["tres", "res", "tscn", "gd", "png", "svg", "jpg", "webp"] },
		});
		if (!picked?.length) return;
		const document = await vscode.workspace.openTextDocument(uri);
		const parsed = parseResourceDocument(document.getText());
		const relative = toResPath(uri, picked[0]);
		const existing = parsed.extResources.find((entry) => entry.path === relative);
		let text = document.getText();
		let id = existing?.id;
		if (!id) {
			const added = applyResourceEdits(text, [{ kind: "addExtResource", type: extResourceType(picked[0]), path: relative }]);
			text = added.text;
			id = added.createdIds[0];
		}
		const result = applyResourceEdits(text, [{ kind: "setProperty", name: propertyName, target, value: `ExtResource("${id}")` }]);
		await this.replaceText(document, result.text);
	}

	// ----------------------------------------------------------------- editing

	private async applyEdits(uri: vscode.Uri, edits: ResourceEdit[]): Promise<void> {
		const document = await vscode.workspace.openTextDocument(uri);
		const result = applyResourceEdits(document.getText(), edits);
		if (result.text === document.getText()) return;
		await this.replaceText(document, result.text);
	}

	/** Creates a sub-resource of `type` and assigns it to the selected property. */
	private async createSubResource(uri: vscode.Uri, propertyName: string, type: string, target?: string): Promise<void> {
		const document = await vscode.workspace.openTextDocument(uri);
		const added = applyResourceEdits(document.getText(), [{ kind: "addSubResource", type }]);
		const id = added.createdIds[0];
		if (!id) return;
		const result = applyResourceEdits(added.text, [{ kind: "setProperty", name: propertyName, target, value: `SubResource("${id}")` }]);
		await this.replaceText(document, result.text);
	}

	private async replaceText(document: vscode.TextDocument, text: string): Promise<void> {
		const edit = new vscode.WorkspaceEdit();
		const fullRange = new vscode.Range(document.positionAt(0), document.positionAt(document.getText().length));
		edit.replace(document.uri, fullRange, text);
		await vscode.workspace.applyEdit(edit);
	}

	// ------------------------------------------------------------------ models

	private async reloadDocument(uri: vscode.Uri, webview: vscode.Webview | undefined, updateDiagnostics: boolean): Promise<void> {
		if (!webview) return;
		const document = await vscode.workspace.openTextDocument(uri);
		await this.sendModel(document, webview, updateDiagnostics);
	}

	private async sendModel(document: vscode.TextDocument, webview: vscode.Webview, updateDiagnostics = true): Promise<void> {
		if (document.languageId !== "gdresource" && !document.uri.path.endsWith(".tres")) return;
		const model = await this.buildModel(document);
		if (updateDiagnostics) this.publishDiagnostics(document, model);
		this.syncedVersions.set(document.uri.toString(), document.version);
		void webview.postMessage({ type: "model", model });
	}

	private async buildModel(document: vscode.TextDocument): Promise<ResourceModel> {
		const parsed = parseResourceDocument(document.getText());
		const scriptSource = await this.readScript(document.uri, parsed);
		const lspProperties = await this.lspProperties(parsed.resourceType);
		const metadata = collectPropertyMetadata({ document: parsed, scriptSource, lspProperties });
		const known = new Map(metadata.map((property) => [property.name, property]));
		// Only the engine knows every property a native resource type accepts. A
		// script-attached resource inherits from an arbitrary class that cannot be
		// enumerated here, so its property list is never authoritative either.
		const hasScript = parsed.properties.some((property) => property.name === SCRIPT_PROPERTY);
		const complete = !hasScript && (lspProperties?.length ?? 0) > 0;
		const diagnostics = diagnosticsEnabled() ? validateResourceDocument(parsed, metadata, { complete }) : [];

		return {
			uri: document.uri.toString(),
			version: document.version,
			resourceType: parsed.resourceType,
			scriptClass: parsed.scriptClass,
			format: parsed.format,
			uid: parsed.uid,
			properties: parsed.properties.map((property) => this.propertyModel(property, known)),
			subResources: parsed.subResources.map((subResource) => ({
				id: subResource.id,
				type: subResource.type,
				properties: subResource.properties.map((property) => this.propertyModel(property, known, subResource.id)),
			})),
			subResourceTypes: parsed.subResources.map((subResource) => ({ id: subResource.id, type: subResource.type })),
			extResources: parsed.extResources.map((resource) => {
				const uri = resource.path ? resolveResourceUri(document.uri, resource.path) : undefined;
				return {
					id: resource.id,
					type: resource.type,
					path: resource.path,
					uid: resource.uid,
					broken: !uri || !fs.existsSync(uri.fsPath),
				};
			}),
			diagnostics,
			openIn: getOpenIn(),
		};
	}

	private propertyModel(property: PropertyEntry, known: Map<string, PropertyMetadata>, target?: string): PropertyModel {
		const metadata = known.get(property.name);
		return {
			name: property.name,
			valueText: property.valueText,
			raw: property.valueText,
			target,
			metadata,
			widget: widgetForProperty(metadata, property.value),
		};
	}

	private publishDiagnostics(document: vscode.TextDocument, model: ResourceModel): void {
		if (!diagnosticsEnabled()) {
			// The inspector is an editor, not a linter: leave the Problems list of
			// valid resources alone and take back anything reported earlier.
			this.diagnostics.delete(document.uri);
			return;
		}
		this.diagnostics.set(document.uri, model.diagnostics.map((diagnostic) => {
			const line = Math.max(0, Math.min(diagnostic.line, document.lineCount - 1));
			const range = document.lineAt(line).range;
			return new vscode.Diagnostic(range, diagnostic.message, diagnostic.severity === "error" ? vscode.DiagnosticSeverity.Error : vscode.DiagnosticSeverity.Warning);
		}));
	}

	private async onDocumentOpened(document: vscode.TextDocument): Promise<void> {
		if (!isResourceFile(document.uri)) return;
		if (this.panelUri?.toString() === document.uri.toString()) await this.refreshView();
	}

	private async onDocumentChanged(event: vscode.TextDocumentChangeEvent): Promise<void> {
		const uri = event.document.uri;
		if (!isResourceFile(uri)) return;
		const webviews: vscode.Webview[] = [...(this.editors.get(uri.toString()) ?? [])].filter((panel) => panel.visible).map((panel) => panel.webview);
		if (this.view?.visible && this.panelUri?.toString() === uri.toString()) webviews.push(this.view.webview);
		if (!webviews.length) return;

		const previous = this.syncedVersions.get(uri.toString());
		if (previous !== undefined && event.document.version > previous + 1 && event.document.isDirty) {
			// The file changed while the panel had pending edits: let the user decide.
			for (const webview of webviews) void webview.postMessage({ type: "externalChange", text: event.document.getText() });
		}
		for (const webview of webviews) await this.sendModel(event.document, webview);
	}

	// ------------------------------------------------------------------- misc

	private async readScript(uri: vscode.Uri, document: ResourceDocument): Promise<string | undefined> {
		const script = document.properties.find((property) => property.name === SCRIPT_PROPERTY);
		if (!script || script.value.kind !== "ExtResource") return undefined;
		const resource = document.extResources.find((entry) => entry.id === script.value.referenceId);
		if (!resource?.path) return undefined;
		const scriptUri = resolveResourceUri(uri, resource.path);
		if (!scriptUri) return undefined;
		try {
			const bytes = await vscode.workspace.fs.readFile(scriptUri);
			return Buffer.from(bytes).toString("utf8");
		} catch {
			return undefined;
		}
	}

	/** Asks the connected Godot language server for native properties. */
	private async lspProperties(resourceType: string): Promise<LspPropertyInfo[] | undefined> {
		const client = (globalThis as { globals?: { lsp?: { client?: { sendRequest?: (...args: unknown[]) => Promise<unknown> } } } }).globals?.lsp?.client;
		if (!client?.sendRequest) return undefined;
		try {
			const symbol = await client.sendRequest("textDocument/nativeSymbol", { native_class: resourceType, symbol_name: resourceType }) as {
				children?: Array<{ name?: string; detail?: string; kind?: number }>;
			} | undefined;
			const children = symbol?.children ?? [];
			const properties: LspPropertyInfo[] = [];
			for (const child of children) {
				if (!child.name) continue;
				const detail = child.detail ?? "";
				const type = detail.match(/(?:var|const)\s+[\w.]+(?:\s*:\s*([\w\[\]]+))?/)?.[1];
				if (/(?:var|const)\s/.test(detail) || child.kind === 6 || child.kind === 12) {
					properties.push({ name: child.name, type: type ?? "Variant" });
				}
			}
			return properties.length ? properties : undefined;
		} catch {
			return undefined;
		}
	}

	private async html(webview: vscode.Webview): Promise<string> {
		const { resourceInspectorHtml } = await import("./panel_html.js");
		return resourceInspectorHtml(webview, this.context.extensionUri);
	}

	dispose(): void {
		this.diagnostics.dispose();
	}
}

function isResourceFile(uri: vscode.Uri): boolean {
	return uri.scheme === "file" && uri.path.endsWith(".tres");
}

/** Configuration `neoGodotTools.resource.inspector.openIn`. */
export function getOpenIn(): "editor" | "panel" {
	const value = vscode.workspace.getConfiguration("neoGodotTools").get<string>("resource.inspector.openIn");
	return value === "panel" ? "panel" : "editor";
}

/**
 * Configuration `neoGodotTools.resource.inspector.diagnostics`.
 *
 * Validation is opt-in: without the engine's property list it cannot tell a
 * genuine mistake from a property it simply does not know about, and an
 * inspector that decorates valid `.tres` files with errors is worse than one
 * that stays quiet. Godot's own inspector does not lint resources either.
 */
export function diagnosticsEnabled(): boolean {
	return vscode.workspace.getConfiguration("neoGodotTools").get<boolean>("resource.inspector.diagnostics") === true;
}

/** Maps a `res://` path onto a file uri relative to the resource's project. */
export function resolveResourceUri(resourceUri: vscode.Uri, resourcePath: string): vscode.Uri | undefined {
	const normalized = resourcePath.replace(/\\/g, "/");
	if (!normalized.startsWith("res://")) {
		try {
			return vscode.Uri.joinPath(resourceUri, "..", normalized);
		} catch {
			return undefined;
		}
	}
	const relative = normalized.slice("res://".length).split("/");
	const workspaceFolder = vscode.workspace.getWorkspaceFolder(resourceUri);
	const projectRoot = findProjectRoot(resourceUri) ?? workspaceFolder?.uri;
	if (!projectRoot) return undefined;
	return vscode.Uri.joinPath(projectRoot, ...relative);
}

function findProjectRoot(fromFile: vscode.Uri): vscode.Uri | undefined {
	let directory = vscode.Uri.joinPath(fromFile, "..");
	for (let depth = 0; depth < 32; depth++) {
		const candidate = vscode.Uri.joinPath(directory, "project.godot");
		if (fs.existsSync(candidate.fsPath)) return directory;
		const parent = vscode.Uri.joinPath(directory, "..");
		if (parent.fsPath === directory.fsPath) return undefined;
		directory = parent;
	}
	return undefined;
}

function toResPath(resourceUri: vscode.Uri, target: vscode.Uri): string {
	const projectRoot = findProjectRoot(resourceUri) ?? vscode.workspace.getWorkspaceFolder(resourceUri)?.uri;
	if (!projectRoot) return target.fsPath;
	const relative = path.relative(projectRoot.fsPath, target.fsPath).replace(/\\/g, "/");
	return `res://${relative}`;
}

function extResourceType(uri: vscode.Uri): string {
	const extension = path.extname(uri.fsPath).toLowerCase();
	switch (extension) {
		case ".gd": return "Script";
		case ".tscn": return "PackedScene";
		case ".tres": return "Resource";
		case ".png":
		case ".svg":
		case ".jpg":
		case ".webp": return "Texture2D";
		default: return "Resource";
	}
}

export function formatPropertyValue(value: string): string {
	return formatVariant(parseVariant(value).value);
}
