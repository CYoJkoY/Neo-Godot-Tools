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
	SubResourceEntry,
	parseResourceDocument,
} from "./document.js";
import {
	BUILTIN_RESOURCE_PROPERTIES,
	builtinClassProperties,
	collectPropertyMetadata,
	defaultValueForType,
	LspPropertyInfo,
	parseScriptBaseClass,
	parseScriptExports,
	PropertyMetadata,
	widgetForProperty,
} from "./metadata.js";
import { validateResourceDocument } from "./diagnostics.js";
import { formatVariant, parseVariant } from "./values.js";

export const RESOURCE_INSPECTOR_VIEW_TYPE = "neoGodotTools.resourceInspector";
export const RESOURCE_INSPECTOR_VIEW_ID = "neoGodotTools.resourceInspector";
const RESOURCE_INSPECTOR_DIAGNOSTICS_SETTING = "neoGodotTools.resource.inspector.diagnostics";
const LOCKED_RESOURCE_STATE_KEY = "neoGodotTools.resourceInspector.lockedResource";

export interface PropertyModel {
	name: string;
	valueText: string;
	raw: string;
	/** Sub-resource the property belongs to, if any. */
	target?: string;
	/** True when the property is explicitly present in the `.tres` file. */
	definedInFile?: boolean;
	metadata?: PropertyMetadata;
	widget: ReturnType<typeof widgetForProperty>;
}

export interface ResourceModel {
	uri: string;
	fileName?: string;
	resourcePath?: string;
	scriptPath?: string;
	locked?: boolean;
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

export interface WorkspaceResourceItem {
	uri: string;
	label: string;
	resourcePath: string;
}

export interface ResourceInspectorOptions {
	lspClient?: () => { sendRequest?: (...args: unknown[]) => Promise<unknown> } | undefined;
}

const SCRIPT_PROPERTY = "script";

export class ResourceInspectorProvider implements vscode.CustomTextEditorProvider, vscode.WebviewViewProvider {
	private readonly diagnostics = vscode.languages.createDiagnosticCollection("neoGodotTools.resourceInspector");
	private readonly editors = new Map<string, Set<vscode.WebviewPanel>>();
	private readonly syncedVersions = new Map<string, number>();
	private readonly nativePropertiesCache = new Map<string, Promise<LspPropertyInfo[] | undefined>>();
	private readonly watcher = vscode.workspace.createFileSystemWatcher("**/*.tres");
	private view?: vscode.WebviewView;
	private panelUri?: vscode.Uri;
	private locked = false;

	constructor(
		private readonly context: vscode.ExtensionContext,
		private readonly options: ResourceInspectorOptions = {},
	) {
		const lockedPath = this.context.workspaceState?.get<string>(LOCKED_RESOURCE_STATE_KEY);
		if (lockedPath && fs.existsSync(lockedPath)) {
			this.locked = true;
			this.panelUri = vscode.Uri.file(lockedPath);
			void vscode.commands.executeCommand("setContext", "neoGodotTools.context.resourceInspector.locked", true);
		} else {
			this.detectInitialResource();
		}

		this.context.subscriptions.push(
			vscode.window.registerCustomEditorProvider(RESOURCE_INSPECTOR_VIEW_TYPE, this, {
				webviewOptions: { retainContextWhenHidden: true },
				supportsMultipleEditorsPerDocument: true,
			}),
			vscode.window.registerWebviewViewProvider(RESOURCE_INSPECTOR_VIEW_ID, this, {
				webviewOptions: { retainContextWhenHidden: true },
			}),
			vscode.window.onDidChangeActiveTextEditor((editor) => void this.onActiveEditorChanged(editor)),
			...(vscode.window.onDidChangeVisibleTextEditors
				? [vscode.window.onDidChangeVisibleTextEditors((editors) => void this.onVisibleEditorsChanged(editors))]
				: []),
			vscode.workspace.onDidChangeTextDocument((event) => void this.onDocumentChanged(event)),
			vscode.workspace.onDidOpenTextDocument((document) => void this.onDocumentOpened(document)),
			vscode.workspace.onDidSaveTextDocument((document) => void this.onDocumentSaved(document)),
			vscode.workspace.onDidCloseTextDocument((document) => void this.onDocumentClosed(document)),
			vscode.workspace.onDidChangeConfiguration((event) => {
				if (!event.affectsConfiguration(RESOURCE_INSPECTOR_DIAGNOSTICS_SETTING)) return;
				// Turning validation off must also take back what it reported.
				if (!diagnosticsEnabled()) this.diagnostics.clear();
			}),
			this.watcher.onDidCreate((uri) => void this.onFileSystemChanged(uri)),
			this.watcher.onDidChange((uri) => void this.onFileSystemChanged(uri)),
			this.watcher.onDidDelete((uri) => void this.onFileDeleted(uri)),
			this.watcher,
			vscode.commands.registerCommand("neoGodotTools.resourceInspector.refresh", () => this.refresh()),
			vscode.commands.registerCommand("neoGodotTools.resourceInspector.lock", () => this.lockInspector()),
			vscode.commands.registerCommand("neoGodotTools.resourceInspector.unlock", () => this.unlockInspector()),
			vscode.commands.registerCommand("neoGodotTools.resourceInspector.openScript", () => this.openCurrentScript()),
			vscode.commands.registerCommand("neoGodotTools.resourceInspector.openCurrentResource", () => this.openCurrentResource()),
			this.diagnostics,
		);
	}

	// ------------------------------------------------------------------ commands

	/** `Godot Tools: Open Resource Inspector` and the explorer context menu. */
	async openResourceInspector(uri?: vscode.Uri): Promise<void> {
		const target = uri ?? vscode.window.activeTextEditor?.document.uri ?? this.panelUri;
		if (!target) {
			void vscode.window.showWarningMessage("Open a .tres file first, or run the command from the explorer.");
			return;
		}
		this.panelUri = target;
		if (getOpenIn() === "panel") {
			await vscode.commands.executeCommand(`${RESOURCE_INSPECTOR_VIEW_ID}.focus`);
			await this.refreshView();
			return;
		}
		await vscode.commands.executeCommand("vscode.openWith", target, RESOURCE_INSPECTOR_VIEW_TYPE);
		await this.refreshView();
	}

	/** Public refresh entry point for commands and LSP connection status updates. */
	async refresh(): Promise<void> {
		this.nativePropertiesCache.clear();
		await this.refreshView();
		for (const [uriText, panels] of this.editors.entries()) {
			const uri = vscode.Uri.parse(uriText);
			for (const panel of panels) {
				if (panel.visible) await this.reloadDocument(uri, panel.webview, true);
			}
		}
	}

	async lockInspector(): Promise<void> {
		const doc = await this.currentDocument();
		if (!doc) return;
		this.panelUri = doc.uri;
		this.setLocked(true);
		await this.refreshView();
	}

	async unlockInspector(): Promise<void> {
		this.setLocked(false);
		await this.onActiveEditorChanged(vscode.window.activeTextEditor);
		await this.refreshView();
	}

	private setLocked(locked: boolean): void {
		this.locked = locked;
		void vscode.commands.executeCommand("setContext", "neoGodotTools.context.resourceInspector.locked", locked);
		void this.context.workspaceState?.update(
			LOCKED_RESOURCE_STATE_KEY,
			locked && this.panelUri ? this.panelUri.fsPath : "",
		);
	}

	async openCurrentResource(): Promise<void> {
		const doc = await this.currentDocument();
		const target = doc?.uri ?? this.panelUri;
		if (!target) return;
		const opened = await vscode.workspace.openTextDocument(target);
		await vscode.window.showTextDocument(opened, { preview: false });
	}

	async openCurrentScript(): Promise<void> {
		const doc = await this.currentDocument();
		if (!doc) return;
		const parsed = parseResourceDocument(doc.getText());
		const scriptUri = await this.resolveMainScriptUri(doc.uri, parsed);
		if (!scriptUri) {
			void vscode.window.showInformationMessage("This resource does not have an attached script.");
			return;
		}
		const scriptDoc = await vscode.workspace.openTextDocument(scriptUri);
		await vscode.window.showTextDocument(scriptDoc, { preview: true });
	}

	// ------------------------------------------------------- custom text editor

	async resolveCustomTextEditor(document: vscode.TextDocument, panel: vscode.WebviewPanel): Promise<void> {
		const key = document.uri.toString();
		const editors = this.editors.get(key) ?? new Set<vscode.WebviewPanel>();
		editors.add(panel);
		this.editors.set(key, editors);

		panel.webview.options = { enableScripts: true };
		panel.webview.html = await this.html(panel.webview);
		if (!this.locked) this.panelUri = document.uri;
		void this.reloadDocument(document.uri, panel.webview, true);
		void this.refreshView();

		panel.webview.onDidReceiveMessage((message) => void this.onMessage(document.uri, message, panel));
		panel.onDidDispose(() => {
			editors.delete(panel);
			if (!editors.size) this.editors.delete(key);
		});
		panel.onDidChangeViewState(() => {
			if (panel.active) {
				if (!this.locked) this.panelUri = document.uri;
				void this.reloadDocument(document.uri, panel.webview, true);
				void this.refreshView();
			}
		});
	}

	// ------------------------------------------------------------- webview view

	async resolveWebviewView(view: vscode.WebviewView): Promise<void> {
		this.view = view;
		view.webview.options = { enableScripts: true };
		view.webview.html = await this.html(view.webview);
		view.webview.onDidReceiveMessage((message) => {
			void this.onViewMessage(message);
		});
		view.onDidChangeVisibility(() => {
			if (view.visible) void this.refreshView();
		});
		await this.refreshView();
	}

	private async onViewMessage(message: { command?: string; [key: string]: unknown }): Promise<void> {
		switch (message.command) {
			case "ready":
			case "reload":
				await this.refreshView();
				return;
			case "openResource": {
				const raw = String(message.uri ?? "").trim();
				if (!raw) return;
				const target = raw.includes("://") ? vscode.Uri.parse(raw) : vscode.Uri.file(raw);
				this.panelUri = target;
				try {
					const doc = await vscode.workspace.openTextDocument(target);
					void vscode.window.showTextDocument(doc, { preview: true, preserveFocus: true });
				} catch {
					/* ignore if unable to show in editor */
				}
				await this.refreshView();
				return;
			}
			case "browseResourceFile": {
				const picked = await vscode.window.showOpenDialog({
					canSelectMany: false,
					filters: { "Godot resources": ["tres"] },
				});
				if (!picked?.length) return;
				this.panelUri = picked[0];
				try {
					const doc = await vscode.workspace.openTextDocument(picked[0]);
					void vscode.window.showTextDocument(doc, { preview: true, preserveFocus: true });
				} catch {
					/* ignore */
				}
				await this.refreshView();
				return;
			}
			case "toggleLock": {
				if (!this.locked) {
					const doc = await this.currentDocument();
					if (doc) this.panelUri = doc.uri;
				}
				this.setLocked(!this.locked);
				await this.refreshView();
				return;
			}
			case "openScript": {
				await this.openCurrentScript();
				return;
			}
			default: {
				const doc = await this.currentDocument();
				const uri = doc?.uri ?? this.panelUri ?? vscode.window.activeTextEditor?.document.uri;
				if (uri) await this.onMessage(uri, message);
				return;
			}
		}
	}

	private async refreshView(): Promise<void> {
		if (!this.view) return;
		const document = await this.currentDocument();
		if (!document) {
			this.view.description = undefined;
			const resources = await this.discoverWorkspaceResources();
			void this.view.webview.postMessage({ type: "empty", resources });
			return;
		}
		this.panelUri = document.uri;
		const fileName = path.basename(document.uri.fsPath || document.uri.path);
		this.view.description = this.locked ? `🔒 ${fileName}` : fileName;
		await this.sendModel(document, this.view.webview);
	}

	private detectInitialResource(): void {
		const active = vscode.window.activeTextEditor?.document;
		if (active && isResourceDocument(active)) {
			this.panelUri = active.uri;
			return;
		}
		const visible = (vscode.window.visibleTextEditors ?? []).find((editor) => isResourceDocument(editor.document));
		if (visible) {
			this.panelUri = visible.document.uri;
			return;
		}
		const openDoc = (vscode.workspace.textDocuments ?? []).find((doc) => isResourceDocument(doc));
		if (openDoc) {
			this.panelUri = openDoc.uri;
			return;
		}
		if (active?.uri.fsPath.toLowerCase().endsWith(".gd")) {
			const related = this.findRelatedResourceForScript(active.uri);
			if (related) this.panelUri = related;
		}
	}

	private findRelatedResourceForScript(scriptUri: vscode.Uri): vscode.Uri | undefined {
		const candidatePath = scriptUri.fsPath.replace(/\.gd$/i, ".tres");
		if (candidatePath !== scriptUri.fsPath && fs.existsSync(candidatePath)) {
			return vscode.Uri.file(candidatePath);
		}
		for (const doc of vscode.workspace.textDocuments ?? []) {
			if (!isResourceDocument(doc)) continue;
			const parsed = parseResourceDocument(doc.getText());
			for (const ext of parsed.extResources) {
				if (!ext.path) continue;
				const resolved = resolveResourceUri(doc.uri, ext.path);
				if (resolved && resolved.fsPath === scriptUri.fsPath) return doc.uri;
			}
		}
		return undefined;
	}

	private async currentDocument(): Promise<vscode.TextDocument | undefined> {
		if (this.locked && this.panelUri && isResourceFile(this.panelUri)) {
			try {
				return await vscode.workspace.openTextDocument(this.panelUri);
			} catch {
				this.setLocked(false);
			}
		}

		const active = vscode.window.activeTextEditor?.document;
		if (active && isResourceDocument(active)) {
			this.panelUri = active.uri;
			return active;
		}

		if (this.panelUri && isResourceFile(this.panelUri)) {
			try {
				if (this.panelUri.scheme !== "file" || fs.existsSync(this.panelUri.fsPath) || (vscode.workspace.textDocuments ?? []).some((d) => d.uri.toString() === this.panelUri?.toString())) {
					return await vscode.workspace.openTextDocument(this.panelUri);
				}
			} catch {
				/* fall through to visible/open editors */
			}
		}

		const visible = (vscode.window.visibleTextEditors ?? []).find((editor) => isResourceDocument(editor.document))?.document;
		if (visible) {
			this.panelUri = visible.uri;
			return visible;
		}

		const openDoc = (vscode.workspace.textDocuments ?? []).find((doc) => isResourceDocument(doc));
		if (openDoc) {
			this.panelUri = openDoc.uri;
			return openDoc;
		}

		if (active?.uri.fsPath.toLowerCase().endsWith(".gd")) {
			const related = this.findRelatedResourceForScript(active.uri);
			if (related) {
				try {
					this.panelUri = related;
					return await vscode.workspace.openTextDocument(related);
				} catch {
					/* ignore */
				}
			}
		}

		return undefined;
	}

	private async discoverWorkspaceResources(): Promise<WorkspaceResourceItem[]> {
		const results: WorkspaceResourceItem[] = [];
		const seen = new Set<string>();
		const addUri = (uri: vscode.Uri) => {
			const key = uri.toString();
			if (seen.has(key) || !isResourceFile(uri)) return;
			seen.add(key);
			results.push({
				uri: key,
				label: path.basename(uri.fsPath || uri.path),
				resourcePath: toResPath(uri, uri),
			});
		};

		for (const doc of vscode.workspace.textDocuments ?? []) {
			if (isResourceDocument(doc)) addUri(doc.uri);
		}
		try {
			const found = await vscode.workspace.findFiles("**/*.tres", "**/.*", 25);
			for (const uri of found ?? []) addUri(uri);
		} catch {
			/* ignore when workspace.findFiles is unavailable */
		}
		return results.slice(0, 25);
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
			case "openScript":
				await this.openCurrentScript();
				return;
			case "toggleLock":
				this.setLocked(!this.locked);
				await this.reloadDocument(uri, panel ? panel.webview : this.view?.webview, false);
				return;
			case "openExtResource": {
				await this.openExtResource(uri, String(message.id ?? ""));
				return;
			}
			case "setProperty": {
				const name = String(message.name ?? "").trim();
				if (!name) return;
				const value = String(message.value ?? "");
				await this.applyEdits(uri, [{ kind: "setProperty", name, value, target: message.target as string | undefined }]);
				return;
			}
			case "addProperty": {
				const target = message.target as string | undefined;
				const inputName = String(message.name ?? "").trim();
				const name =
					inputName ||
					(await vscode.window.showInputBox({
						prompt: target ? `Property name for '${target}'` : "Property name",
						placeHolder: "e.g. speed, albedo_color, shader_parameter/strength",
					}))?.trim() ||
					"";
				if (!name) return;
				if (!/^[A-Za-z_][A-Za-z0-9_/.]*$/.test(name)) {
					void vscode.window.showWarningMessage("Enter a valid Godot property name.");
					return;
				}
				const rawValue = message.value !== undefined ? String(message.value).trim() : "";
				const value =
					rawValue ||
					(await vscode.window.showInputBox({
						prompt: `Initial value for '${name}'`,
						value: "null",
					}))?.trim() ||
					"";
				if (!value) return;
				await this.applyEdits(uri, [{ kind: "setProperty", name, value, target }]);
				return;
			}
			case "revertProperty": {
				const name = String(message.name ?? "");
				await this.applyEdits(uri, [{ kind: "revertProperty", name, target: message.target as string | undefined, defaultValue: message.defaultValue as string | undefined }]);
				return;
			}
			case "addSubResource": {
				const requestedType = String(message.subType ?? "").trim();
				const type = requestedType || (await vscode.window.showInputBox({ prompt: "Godot resource type", value: "Resource" }))?.trim();
				if (!type) return;
				if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(type)) {
					void vscode.window.showWarningMessage("Enter a valid Godot resource type name.");
					return;
				}
				await this.applyEdits(uri, [{ kind: "addSubResource", type }]);
				return;
			}
			case "duplicateSubResource": {
				await this.applyEdits(uri, [{ kind: "duplicateSubResource", id: String(message.id ?? "") }]);
				return;
			}
			case "deleteSubResource": {
				const id = String(message.id ?? "");
				const confirmation = await vscode.window.showWarningMessage(`Delete '${id}' and replace its references with null?`, { modal: true }, "Delete");
				if (confirmation === "Delete") await this.applyEdits(uri, [{ kind: "deleteSubResource", id }]);
				return;
			}
			case "renameSubResource": {
				const id = String(message.id ?? "");
				const inputId = String(message.newId ?? "").trim();
				const newId = inputId || (await vscode.window.showInputBox({ prompt: "New sub-resource ID", value: id }))?.trim() || "";
				if (!/^[A-Za-z0-9_]+$/.test(newId)) {
					void vscode.window.showWarningMessage("Sub-resource IDs may contain only letters, numbers, and underscores.");
					return;
				}
				const document = await vscode.workspace.openTextDocument(uri);
				const parsed = parseResourceDocument(document.getText());
				if (!parsed.subResources.some((resource) => resource.id === id)) return;
				if (newId !== id && parsed.subResources.some((resource) => resource.id === newId)) {
					void vscode.window.showWarningMessage(`A sub-resource named '${newId}' already exists.`);
					return;
				}
				await this.applyEdits(uri, [{ kind: "renameSubResource", id, newId }]);
				return;
			}
			case "addExternalResource": {
				await this.addExternalResource(uri);
				return;
			}
			case "deleteExtResource": {
				const id = String(message.id ?? "");
				if (!id) return;
				await this.applyEdits(uri, [{ kind: "deleteExtResource", id }]);
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

	/** Adds an external resource without assigning it to a property yet. */
	private async addExternalResource(uri: vscode.Uri): Promise<void> {
		const picked = await vscode.window.showOpenDialog({
			canSelectMany: false,
			filters: { "Godot resources": ["tres", "res", "tscn", "gd", "gdshader", "png", "svg", "jpg", "webp"] },
		});
		if (!picked?.length) return;
		const document = await vscode.workspace.openTextDocument(uri);
		const text = document.getText();
		const resourcePath = toResPath(uri, picked[0]);
		if (parseResourceDocument(text).extResources.some((resource) => resource.path === resourcePath)) {
			void vscode.window.showInformationMessage("This external resource is already included.");
			return;
		}
		const result = applyResourceEdits(text, [{
			kind: "addExtResource",
			type: extResourceType(picked[0]),
			path: resourcePath,
		}]);
		await this.replaceText(document, result.text);
	}

	/** Opens a `.tres` as an `ExtResource` for the selected property. */
	private async pickResource(uri: vscode.Uri, propertyName: string, target?: string): Promise<void> {
		const picked = await vscode.window.showOpenDialog({
			canSelectMany: false,
			filters: { "Godot resources": ["tres", "res", "tscn", "gd", "gdshader", "png", "svg", "jpg", "webp"] },
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
		this.syncedVersions.set(document.uri.toString(), document.version + 1);
		await vscode.workspace.applyEdit(edit);
	}

	// ------------------------------------------------------------------ models

	private async reloadDocument(uri: vscode.Uri, webview: vscode.Webview | undefined, updateDiagnostics: boolean): Promise<void> {
		if (!webview) return;
		const document = await vscode.workspace.openTextDocument(uri);
		await this.sendModel(document, webview, updateDiagnostics);
	}

	private async sendModel(document: vscode.TextDocument, webview: vscode.Webview, updateDiagnostics = true): Promise<void> {
		if (!isResourceDocument(document)) return;
		const version = document.version;
		this.syncedVersions.set(document.uri.toString(), version);
		const model = await this.buildModel(document);
		// Async script/LSP metadata must not let an older parse overwrite a newer edit.
		if (document.version !== version) return;
		if (updateDiagnostics) this.publishDiagnostics(document, model);
		void webview.postMessage({ type: "model", model });
	}

	async buildModel(document: vscode.TextDocument): Promise<ResourceModel> {
		const parsed = parseResourceDocument(document.getText());
		const { scriptSource, scriptPath, nativeBaseType } = await this.readScriptChain(document.uri, parsed);
		const shaderSource = await this.readShaderSource(document.uri, parsed);
		const lspProperties = await this.lspProperties(nativeBaseType ?? parsed.resourceType);
		const metadata = collectPropertyMetadata({ document: parsed, scriptSource, shaderSource, lspProperties });
		const known = new Map(metadata.map((property) => [property.name, property]));
		// Only the engine knows every property a native resource type accepts. A
		// script-attached resource inherits from an arbitrary class that cannot be
		// enumerated here, so its property list is never authoritative either.
		const hasScript = parsed.properties.some((property) => property.name === SCRIPT_PROPERTY) || Boolean(scriptSource);
		const complete = !hasScript && (lspProperties?.length ?? 0) > 0;
		const diagnostics = validateResourceDocument(parsed, metadata, { complete });

		const extResources = parsed.extResources.map((resource) => {
			const uri = resource.path ? resolveResourceUri(document.uri, resource.path) : undefined;
			const broken = !uri || !fs.existsSync(uri.fsPath);
			return {
				id: resource.id,
				type: resource.type,
				path: resource.path,
				uid: resource.uid,
				broken,
			};
		});

		const properties = this.mergePropertiesWithMetadata(parsed.properties, metadata, known);
		const subResources = await Promise.all(
			parsed.subResources.map((subResource) => this.buildSubResourceModel(document.uri, parsed, subResource)),
		);

		return {
			uri: document.uri.toString(),
			fileName: path.basename(document.uri.fsPath || document.uri.path),
			resourcePath: toResPath(document.uri, document.uri),
			scriptPath,
			locked: this.locked,
			version: document.version,
			resourceType: parsed.resourceType,
			scriptClass: parsed.scriptClass,
			format: parsed.format,
			uid: parsed.uid,
			properties,
			subResources,
			subResourceTypes: parsed.subResources.map((subResource) => ({ id: subResource.id, type: subResource.type })),
			extResources,
			diagnostics,
			openIn: getOpenIn(),
		};
	}

	private mergePropertiesWithMetadata(
		entries: readonly PropertyEntry[],
		metadataList: readonly PropertyMetadata[],
		known: Map<string, PropertyMetadata>,
		target?: string,
	): PropertyModel[] {
		const present = new Set(entries.map((entry) => entry.name));
		const result: PropertyModel[] = entries.map((property) => this.propertyModel(property, known, target));

		const builtinNames = new Set(BUILTIN_RESOURCE_PROPERTIES.map((item) => item.name));
		const deferredBuiltins: PropertyMetadata[] = [];

		for (const meta of metadataList) {
			if (present.has(meta.name) || meta.source === "file") continue;
			if (builtinNames.has(meta.name)) {
				if (!target) deferredBuiltins.push(meta);
				continue;
			}
			result.push(this.defaultPropertyModel(meta, target));
		}

		for (const meta of deferredBuiltins) {
			result.push(this.defaultPropertyModel({ ...meta, category: meta.category ?? "Resource" }, target));
		}

		return result;
	}

	private async buildSubResourceModel(
		documentUri: vscode.Uri,
		document: ResourceDocument,
		subResource: SubResourceEntry,
	): Promise<{ id: string; type: string; properties: PropertyModel[] }> {
		const subDoc: ResourceDocument = {
			text: "",
			lineEnding: document.lineEnding,
			resourceType: subResource.type,
			headerLine: subResource.line,
			extResources: document.extResources,
			subResources: document.subResources,
			properties: subResource.properties,
		};
		const { scriptSource } = await this.readScriptChain(documentUri, subDoc);
		const lspProperties = await this.lspProperties(subResource.type);
		const metadataList: PropertyMetadata[] = [
			...builtinClassProperties(subResource.type),
			...(lspProperties ?? []).map((prop) => ({
				name: prop.name,
				type: prop.type ?? "Variant",
				hint: prop.hint,
				hintString: prop.hint_string,
				source: "lsp" as const,
			})),
			...(scriptSource ? parseScriptExports(scriptSource) : []),
		];
		const known = new Map<string, PropertyMetadata>();
		for (const meta of metadataList) known.set(meta.name, meta);
		for (const prop of subResource.properties) {
			if (!known.has(prop.name)) {
				known.set(prop.name, {
					name: prop.name,
					type: prop.value.kind === "Variant" ? "Variant" : prop.value.kind,
					defaultValue: prop.valueText,
					source: "file",
				});
			}
		}

		return {
			id: subResource.id,
			type: subResource.type,
			properties: this.mergePropertiesWithMetadata(subResource.properties, [...known.values()], known, subResource.id),
		};
	}

	private propertyModel(property: PropertyEntry, known: Map<string, PropertyMetadata>, target?: string): PropertyModel {
		const rawMeta = known.get(property.name);
		const metadata = rawMeta
			? {
				...rawMeta,
				defaultValue:
					rawMeta.defaultValue !== undefined
						? rawMeta.defaultValue
						: rawMeta.source !== "file"
							? defaultValueForType(rawMeta.type)
							: undefined,
			}
			: undefined;
		return {
			name: property.name,
			valueText: property.valueText,
			raw: property.valueText,
			target,
			definedInFile: true,
			metadata,
			widget: widgetForProperty(metadata, property.value),
		};
	}

	private defaultPropertyModel(meta: PropertyMetadata, target?: string): PropertyModel {
		const defaultText = meta.defaultValue ?? defaultValueForType(meta.type);
		const effectiveMeta: PropertyMetadata = {
			...meta,
			defaultValue: defaultText,
		};
		const parsedValue = parseVariant(defaultText).value;
		return {
			name: meta.name,
			valueText: defaultText,
			raw: defaultText,
			target,
			definedInFile: false,
			metadata: effectiveMeta,
			widget: widgetForProperty(effectiveMeta, parsedValue),
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

	// --------------------------------------------------------- event handlers

	private async onActiveEditorChanged(editor?: vscode.TextEditor): Promise<void> {
		if (this.locked && this.panelUri && fs.existsSync(this.panelUri.fsPath)) {
			return;
		}
		if (editor && isResourceDocument(editor.document)) {
			this.panelUri = editor.document.uri;
			await this.refreshView();
			return;
		}
		if (editor?.document.uri.fsPath.toLowerCase().endsWith(".gd")) {
			if (!this.panelUri) {
				const related = this.findRelatedResourceForScript(editor.document.uri);
				if (related) {
					this.panelUri = related;
					await this.refreshView();
				}
			} else {
				await this.refreshView();
			}
		}
	}

	private async onVisibleEditorsChanged(editors: readonly vscode.TextEditor[]): Promise<void> {
		if (this.locked && this.panelUri && fs.existsSync(this.panelUri.fsPath)) return;
		const active = vscode.window.activeTextEditor?.document;
		if (active && isResourceDocument(active)) {
			this.panelUri = active.uri;
			await this.refreshView();
			return;
		}
		if (!this.panelUri) {
			const visible = editors.find((editor) => isResourceDocument(editor.document));
			if (visible) {
				this.panelUri = visible.document.uri;
				await this.refreshView();
			}
		}
	}

	private async onDocumentOpened(document: vscode.TextDocument): Promise<void> {
		if (!isResourceDocument(document)) return;
		if (!this.locked) {
			const activeUri = vscode.window.activeTextEditor?.document.uri;
			if (!this.panelUri || this.panelUri.toString() === document.uri.toString() || !activeUri || activeUri.toString() === document.uri.toString()) {
				this.panelUri = document.uri;
				await this.refreshView();
				return;
			}
		}
		if (this.panelUri?.toString() === document.uri.toString()) await this.refreshView();
	}

	private async onDocumentSaved(document: vscode.TextDocument): Promise<void> {
		const filePath = document.uri.fsPath.toLowerCase();
		if (filePath.endsWith(".gd") || filePath.endsWith(".gdshader") || isResourceDocument(document)) {
			await this.refreshView();
		}
	}

	private async onDocumentClosed(document: vscode.TextDocument): Promise<void> {
		if (!isResourceDocument(document)) return;
		if (!this.locked && this.panelUri?.toString() === document.uri.toString()) {
			const nextVisible = (vscode.window.visibleTextEditors ?? []).find(
				(editor) => isResourceDocument(editor.document) && editor.document.uri.toString() !== document.uri.toString(),
			);
			if (nextVisible) {
				this.panelUri = nextVisible.document.uri;
				await this.refreshView();
			}
		}
	}

	private async onFileSystemChanged(uri: vscode.Uri): Promise<void> {
		if (!isResourceFile(uri)) return;
		if (this.panelUri?.toString() === uri.toString() || !this.panelUri) {
			if (!this.locked && !this.panelUri) this.panelUri = uri;
			await this.refreshView();
		}
	}

	private async onFileDeleted(uri: vscode.Uri): Promise<void> {
		if (this.panelUri?.toString() === uri.toString()) {
			this.panelUri = undefined;
			this.setLocked(false);
			await this.refreshView();
		}
	}

	private async onDocumentChanged(event: vscode.TextDocumentChangeEvent): Promise<void> {
		const uri = event.document.uri;
		const lowerPath = uri.path.toLowerCase();
		if (lowerPath.endsWith(".gd") || lowerPath.endsWith(".gdshader")) {
			// If an attached script or shader is edited while a resource is being
			// inspected, refresh the inspector so new @export/uniform properties appear.
			if (this.view?.visible && this.panelUri) void this.refreshView();
			for (const [resUriText, panels] of this.editors.entries()) {
				const resUri = vscode.Uri.parse(resUriText);
				for (const panel of panels) {
					if (panel.visible) void this.reloadDocument(resUri, panel.webview, true);
				}
			}
			return;
		}

		if (!isResourceDocument(event.document)) return;
		if (!this.locked && !this.panelUri) {
			this.panelUri = uri;
		}
		const webviews: vscode.Webview[] = [...(this.editors.get(uri.toString()) ?? [])].filter((panel) => panel.visible).map((panel) => panel.webview);
		if (this.view && (this.view.visible ?? true) && this.panelUri?.toString() === uri.toString()) {
			webviews.push(this.view.webview);
		}
		if (!webviews.length) return;

		const previous = this.syncedVersions.get(uri.toString());
		if (previous !== undefined && event.document.version > previous + 1 && event.document.isDirty) {
			// The file changed while the panel had pending edits: let the user decide.
			for (const webview of webviews) void webview.postMessage({ type: "externalChange", text: event.document.getText() });
		}
		await Promise.all(webviews.map((webview) => this.sendModel(event.document, webview)));
	}

	// ------------------------------------------------------------------- misc

	private async resolveMainScriptUri(uri: vscode.Uri, document: ResourceDocument): Promise<vscode.Uri | undefined> {
		const scriptProp = document.properties.find((property) => property.name === SCRIPT_PROPERTY);
		if (scriptProp && scriptProp.value.kind === "ExtResource") {
			const resource = document.extResources.find((entry) => entry.id === scriptProp.value.referenceId);
			if (resource?.path) {
				const resolved = resolveResourceUri(uri, resource.path);
				if (resolved) return resolved;
			}
		}
		const fallbackScriptExt = document.extResources.find((entry) => entry.type === "Script" && entry.path);
		if (fallbackScriptExt?.path) {
			const resolved = resolveResourceUri(uri, fallbackScriptExt.path);
			if (resolved) return resolved;
		}
		if (document.scriptClass) {
			return this.findScriptByClassName(uri, document.scriptClass);
		}
		return undefined;
	}

	private async readScriptChain(
		uri: vscode.Uri,
		document: ResourceDocument,
	): Promise<{ scriptSource?: string; scriptPath?: string; nativeBaseType?: string }> {
		const mainUri = await this.resolveMainScriptUri(uri, document);
		if (!mainUri) return {};

		const sources: string[] = [];
		const visited = new Set<string>();
		let currentUri: vscode.Uri | undefined = mainUri;
		let nativeBaseType: string | undefined;

		for (let depth = 0; depth < 8 && currentUri; depth++) {
			const key = currentUri.fsPath || currentUri.toString();
			if (visited.has(key)) break;
			visited.add(key);

			const text = await this.readTextFile(currentUri);
			if (!text) break;
			sources.unshift(text);

			const base = parseScriptBaseClass(text);
			if (!base) break;
			if (base.startsWith("res://") || base.startsWith(".") || base.endsWith(".gd")) {
				currentUri = resolveResourceUri(currentUri, base);
			} else {
				const classScript = this.findScriptByClassName(uri, base);
				if (classScript) {
					currentUri = classScript;
				} else {
					nativeBaseType = base;
					break;
				}
			}
		}

		return {
			scriptSource: sources.length ? sources.join("\n") : undefined,
			scriptPath: toResPath(uri, mainUri),
			nativeBaseType,
		};
	}

	private async readShaderSource(uri: vscode.Uri, document: ResourceDocument): Promise<string | undefined> {
		const shaderProp = document.properties.find((property) => property.name === "shader");
		if (shaderProp?.value.kind === "SubResource") {
			const sub = document.subResources.find((entry) => entry.id === shaderProp.value.referenceId);
			const codeProp = sub?.properties.find((property) => property.name === "code");
			if (codeProp?.value.text !== undefined) return codeProp.value.text;
		} else if (shaderProp?.value.kind === "ExtResource") {
			const ext = document.extResources.find((entry) => entry.id === shaderProp.value.referenceId);
			if (ext?.path) {
				const shaderUri = resolveResourceUri(uri, ext.path);
				if (shaderUri) return this.readTextFile(shaderUri);
			}
		}
		const inlineShader = document.subResources.find((entry) => entry.type === "Shader");
		const codeProp = inlineShader?.properties.find((property) => property.name === "code");
		return codeProp?.value.text;
	}

	private async readTextFile(targetUri: vscode.Uri): Promise<string | undefined> {
		const openDoc = (vscode.workspace.textDocuments ?? []).find(
			(doc) => doc.uri.toString() === targetUri.toString() || (doc.uri.fsPath && doc.uri.fsPath === targetUri.fsPath),
		);
		if (openDoc) return openDoc.getText();
		try {
			const bytes = await vscode.workspace.fs.readFile(targetUri);
			return Buffer.from(bytes).toString("utf8");
		} catch {
			return undefined;
		}
	}

	private findScriptByClassName(contextUri: vscode.Uri, className: string): vscode.Uri | undefined {
		const classRe = new RegExp(`^\\s*class_name\\s+${className}\\b`, "m");
		for (const doc of vscode.workspace.textDocuments ?? []) {
			if (doc.uri.fsPath.toLowerCase().endsWith(".gd") && classRe.test(doc.getText())) {
				return doc.uri;
			}
		}
		const projectRoot = findProjectRoot(contextUri) ?? vscode.workspace.getWorkspaceFolder(contextUri)?.uri;
		if (!projectRoot || !fs.existsSync(projectRoot.fsPath)) return undefined;
		return findScriptInDirectory(projectRoot.fsPath, classRe, 0);
	}

	/** Asks the connected Godot language server for native properties. */
	private lspProperties(resourceType: string): Promise<LspPropertyInfo[] | undefined> {
		const cached = this.nativePropertiesCache.get(resourceType);
		if (cached) return cached;
		const client =
			this.options.lspClient?.() ??
			(globalThis as { globals?: { lsp?: { client?: { sendRequest?: (...args: unknown[]) => Promise<unknown> } } } }).globals?.lsp?.client;
		if (!client?.sendRequest) return Promise.resolve(undefined);
		const sendRequest = client.sendRequest.bind(client);
		const request = (async () => {
			try {
				const symbol = await sendRequest("textDocument/nativeSymbol", { native_class: resourceType, symbol_name: resourceType }) as {
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
				if (!properties.length) {
					this.nativePropertiesCache.delete(resourceType);
					return undefined;
				}
				return properties;
			} catch {
				this.nativePropertiesCache.delete(resourceType);
				return undefined;
			}
		})();
		this.nativePropertiesCache.set(resourceType, request);
		return request;
	}

	private async html(webview: vscode.Webview): Promise<string> {
		const { resourceInspectorHtml } = await import("./panel_html.js");
		return resourceInspectorHtml(webview, this.context.extensionUri);
	}

	dispose(): void {
		this.watcher.dispose();
		this.diagnostics.dispose();
	}
}

function findScriptInDirectory(dirPath: string, classRe: RegExp, depth: number): vscode.Uri | undefined {
	if (depth > 6) return undefined;
	let entries: fs.Dirent[];
	try {
		entries = fs.readdirSync(dirPath, { withFileTypes: true });
	} catch {
		return undefined;
	}
	for (const entry of entries) {
		if (entry.name.startsWith(".") || entry.name === "node_modules" || entry.name === "out") continue;
		const fullPath = path.join(dirPath, entry.name);
		if (entry.isDirectory()) {
			const nested = findScriptInDirectory(fullPath, classRe, depth + 1);
			if (nested) return nested;
		} else if (entry.isFile() && entry.name.toLowerCase().endsWith(".gd")) {
			try {
				const content = fs.readFileSync(fullPath, "utf8");
				if (classRe.test(content)) return vscode.Uri.file(fullPath);
			} catch {
				/* ignore unreadable files */
			}
		}
	}
	return undefined;
}

function isResourceFile(uri: vscode.Uri | undefined): boolean {
	if (!uri) return false;
	return (uri.scheme === "file" || uri.scheme === "untitled") && uri.path.toLowerCase().endsWith(".tres");
}

function isResourceDocument(document: vscode.TextDocument | undefined): boolean {
	if (!document) return false;
	if (isResourceFile(document.uri)) return true;
	return document.languageId === "gdresource" && document.uri.path.toLowerCase().endsWith(".tres");
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
		case ".gdshader": return "Shader";
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
