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
	resourceReference,
} from "./document.js";
import {
	BUILTIN_RESOURCE_PROPERTIES,
	collectPropertyMetadata,
	defaultValueForType,
	LspPropertyInfo,
	parseScriptBaseClass,
	knownDefaultValue,
	PropertyMetadata,
	widgetForProperty,
} from "./metadata.js";
import { validateResourceDocument } from "./diagnostics.js";
import { formatVariant, parseVariant, variantValuesEqual } from "./values.js";
import { scriptClassNameIndex } from "./script_index.js";
import { withTimeout } from "../utils/scheduling.js";

export const RESOURCE_INSPECTOR_VIEW_TYPE = "neoGodotTools.resourceInspector";
export const RESOURCE_INSPECTOR_VIEW_ID = "neoGodotTools.resourceInspector";
const RESOURCE_INSPECTOR_DIAGNOSTICS_SETTING = "neoGodotTools.resource.inspector.diagnostics";
const LOCKED_RESOURCE_STATE_KEY = "neoGodotTools.resourceInspector.lockedResource";

export interface ImagePreview {
	path: string;
	/** Webview-scoped URI, never a raw file:// URL. */
	uri?: string;
	message?: string;
}

export interface PropertyModel {
	name: string;
	valueText: string;
	raw: string;
	/** Sub-resource the property belongs to, if any. */
	target?: string;
	/** True when the property is explicitly present in the `.tres` file. */
	definedInFile?: boolean;
	modified: boolean;
	/** Parsed components avoid extracting the digit in e.g. Vector2i. */
	components?: number[];
	constructorName?: string;
	imagePreview?: ImagePreview;
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
	extResources: Array<{ id: string; type: string; path?: string; uid?: string; broken: boolean; imagePreview?: ImagePreview }>;
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
	/** Upper bound for language-server metadata requests. */
	lspTimeoutMs?: number;
}

const SCRIPT_PROPERTY = "script";

export class ResourceInspectorProvider implements vscode.CustomTextEditorProvider, vscode.WebviewViewProvider {
	private readonly diagnostics = vscode.languages.createDiagnosticCollection("neoGodotTools.resourceInspector");
	private readonly editors = new Map<string, Set<vscode.WebviewPanel>>();
	private readonly syncedVersions = new Map<string, number>();
	private readonly modelGenerations = new WeakMap<vscode.Webview, number>();
	private readonly nativePropertiesCache = new Map<string, Promise<LspPropertyInfo[] | undefined>>();
	private readonly watcher = vscode.workspace.createFileSystemWatcher("**/*.tres");
	private readonly scriptWatcher = vscode.workspace.createFileSystemWatcher("**/*.gd");
	private readonly pendingModelUpdates = new Map<string, ReturnType<typeof setTimeout>>();
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
			// `class_name` lookup and script metadata must not survive a script edit.
			this.scriptWatcher.onDidCreate(() => scriptClassNameIndex.invalidate()),
			this.scriptWatcher.onDidChange(() => scriptClassNameIndex.invalidate()),
			this.scriptWatcher.onDidDelete(() => scriptClassNameIndex.invalidate()),
			this.scriptWatcher,
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
			case "openImage": {
				const document = await vscode.workspace.openTextDocument(uri);
				const parsed = parseResourceDocument(document.getText());
				const owner = message.target ? parsed.subResources.find((sub) => sub.id === message.target) : undefined;
				if (message.target && !owner) return;
				const property = (owner?.properties ?? parsed.properties).find((entry) => entry.name === message.name);
				let raw = property?.valueText;
				if (raw === undefined) {
					const model = await this.buildModel(document);
					const properties = owner ? model.subResources.find((sub) => sub.id === owner.id)?.properties : model.properties;
					raw = properties?.find((prop) => prop.name === message.name)?.raw;
				}
				const imagePath = raw === undefined ? undefined : imagePathForValue(raw, parsed);
				if (imagePath && GODOT_IMAGE_EXTENSIONS.has(path.extname(imagePath).toLowerCase())) await this.openImage(uri, imagePath);
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
				// Re-read the real default: the webview may have stale metadata, and
				// unknown defaults must remove the override instead of writing zero.
				const document = await vscode.workspace.openTextDocument(uri);
				const model = await this.buildModel(document);
				const target = message.target as string | undefined;
				const properties = target ? model.subResources.find((sub) => sub.id === target)?.properties : model.properties;
				const property = properties?.find((prop) => prop.name === name);
				if (property) await this.applyEdits(uri, [{ kind: "revertProperty", name, target, defaultValue: knownDefaultValue(property.metadata) }]);
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

	private async openImage(uri: vscode.Uri, imagePath: string): Promise<void> {
		const target = resolveResourceUri(uri, imagePath);
		if (!target || !fs.existsSync(target.fsPath)) {
			void vscode.window.showWarningMessage(`'${imagePath}' no longer exists.`);
			return;
		}
		await vscode.commands.executeCommand("vscode.open", target, { preview: true });
	}

	/** Adds an external resource without assigning it to a property yet. */
	private async addExternalResource(uri: vscode.Uri): Promise<void> {
		const picked = await vscode.window.showOpenDialog({
			canSelectMany: false,
			filters: { "Godot resources": ["tres", "res", "tscn", "gd", "gdshader", "png", "svg", "jpg", "jpeg", "webp", "gif", "bmp"] },
		});
		if (!picked?.length) return;
		const document = await vscode.workspace.openTextDocument(uri);
		const text = document.getText();
		const resourcePath = toResPath(uri, picked[0]);
		const parsed = parseResourceDocument(text);
		if (parsed.extResources.some((resource) => resource.path === resourcePath)) {
			void vscode.window.showInformationMessage("This external resource is already included.");
			return;
		}
		const result = applyResourceEdits(text, [{
			kind: "addExtResource",
			type: extResourceType(picked[0], parsed.format),
			path: resourcePath,
		}]);
		await this.replaceText(document, result.text);
	}

	/** Opens a `.tres` as an `ExtResource` for the selected property. */
	private async pickResource(uri: vscode.Uri, propertyName: string, target?: string): Promise<void> {
		const picked = await vscode.window.showOpenDialog({
			canSelectMany: false,
			filters: { "Godot resources": ["tres", "res", "tscn", "gd", "gdshader", "png", "svg", "jpg", "jpeg", "webp", "gif", "bmp"] },
		});
		if (!picked?.length) return;
		const document = await vscode.workspace.openTextDocument(uri);
		const parsed = parseResourceDocument(document.getText());
		const relative = toResPath(uri, picked[0]);
		const existing = parsed.extResources.find((entry) => entry.path === relative);
		let text = document.getText();
		let id = existing?.id;
		if (!id) {
			const added = applyResourceEdits(text, [{ kind: "addExtResource", type: extResourceType(picked[0], parsed.format), path: relative }]);
			text = added.text;
			id = added.createdIds[0];
		}
		const result = applyResourceEdits(text, [{ kind: "setProperty", name: propertyName, target, value: resourceReference("Ext", id!, parsed.format) }]);
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
		const generation = (this.modelGenerations.get(webview) ?? 0) + 1;
		this.modelGenerations.set(webview, generation);
		this.syncedVersions.set(document.uri.toString(), version);
		const model = await this.buildModel(document, webview);
		// Async script/LSP metadata must not overwrite newer edits or a newly
		// selected resource, including its webview preview permissions. A script
		// edit can trigger a newer model without changing the .tres version.
		if (this.modelGenerations.get(webview) !== generation || document.version !== version || (this.view?.webview === webview && this.panelUri?.toString() !== document.uri.toString())) return;
		webview.options = { ...webview.options, localResourceRoots: previewRoots(document.uri) };
		if (updateDiagnostics) this.publishDiagnostics(document, model);
		void webview.postMessage({ type: "model", model });
	}

	async buildModel(document: vscode.TextDocument, webview?: vscode.Webview): Promise<ResourceModel> {
		const parsed = parseResourceDocument(document.getText());
		const { scriptSource, scriptPath, nativeBaseType } = await this.readScriptChain(document.uri, parsed);
		const shaderSource = (nativeBaseType ?? parsed.resourceType) === "ShaderMaterial" ? await this.readShaderSource(document.uri, parsed) : undefined;
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
				imagePreview: imagePreviewForPath(document.uri, resource.path, webview),
			};
		});

		const properties = this.mergePropertiesWithMetadata(parsed.properties, metadata, known);
		const subResources = await Promise.all(
			parsed.subResources.map((subResource) => this.buildSubResourceModel(document.uri, parsed, subResource)),
		);

		for (const property of [...properties, ...subResources.flatMap((sub) => sub.properties)]) {
			property.imagePreview = imagePreviewForPath(document.uri, imagePathForValue(property.raw, parsed), webview);
		}

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
		subDoc.format = document.format;
		const { scriptSource, nativeBaseType } = await this.readScriptChain(documentUri, subDoc);
		const lspProperties = await this.lspProperties(nativeBaseType ?? subResource.type);
		const shaderSource = (nativeBaseType ?? subResource.type) === "ShaderMaterial" ? await this.readShaderSource(documentUri, subDoc) : undefined;
		const metadata = collectPropertyMetadata({ document: subDoc, scriptSource, shaderSource, lspProperties });
		const known = new Map(metadata.map((meta) => [meta.name, meta]));
		return {
			id: subResource.id,
			type: subResource.type,
			properties: this.mergePropertiesWithMetadata(subResource.properties, metadata, known, subResource.id),
		};
	}

	private propertyModel(property: PropertyEntry, known: Map<string, PropertyMetadata>, target?: string): PropertyModel {
		const rawMeta = known.get(property.name);
		const defaultValue = knownDefaultValue(rawMeta);
		const metadata = rawMeta ? { ...rawMeta, defaultValue } : undefined;
		return {
			name: property.name,
			valueText: property.valueText,
			raw: property.valueText,
			target,
			definedInFile: true,
			modified: defaultValue === undefined || !variantValuesEqual(property.valueText, defaultValue),
			components: property.value.components,
			constructorName: property.value.typeName ?? property.value.kind,
			metadata,
			widget: widgetForProperty(metadata, property.value),
		};
	}

	private defaultPropertyModel(meta: PropertyMetadata, target?: string): PropertyModel {
		const defaultValue = knownDefaultValue(meta);
		// A type placeholder is useful for editing an unserialized native
		// property, but it is NOT evidence of that property's engine default.
		const defaultText = defaultValue ?? defaultValueForType(meta.type);
		const metadata = { ...meta, defaultValue };
		const parsedValue = parseVariant(defaultText).value;
		return {
			name: meta.name,
			valueText: defaultText,
			raw: defaultText,
			target,
			definedInFile: false,
			modified: false,
			components: parsedValue.components,
			constructorName: parsedValue.typeName ?? parsedValue.kind,
			metadata,
			widget: widgetForProperty(metadata, parsedValue),
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
		// Typing produces one event per keystroke; rebuilding the whole model
		// (script chain, shader, metadata, previews) that often kept the
		// extension host busy while the inspector was open. Coalesce the edits.
		this.scheduleModelUpdate(uri, webviews);
	}

	private scheduleModelUpdate(uri: vscode.Uri, webviews: vscode.Webview[]): void {
		const key = uri.toString();
		const pending = this.pendingModelUpdates.get(key);
		if (pending) clearTimeout(pending);
		this.pendingModelUpdates.set(
			key,
			setTimeout(() => {
				this.pendingModelUpdates.delete(key);
				void this.flushModelUpdate(uri, webviews);
			}, MODEL_UPDATE_DEBOUNCE_MS),
		);
	}

	private async flushModelUpdate(uri: vscode.Uri, webviews: vscode.Webview[]): Promise<void> {
		try {
			const document = await vscode.workspace.openTextDocument(uri);
			if (!isResourceDocument(document)) return;
			await Promise.all(webviews.map((webview) => this.sendModel(document, webview)));
		} catch {
			/* the document may have been closed while the update was pending */
		}
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
		if (scriptProp) return undefined;
		const fallbackScriptExt = document.scriptClass ? document.extResources.find((entry) => entry.type === "Script" && entry.path) : undefined;
		if (fallbackScriptExt?.path) {
			const resolved = resolveResourceUri(uri, fallbackScriptExt.path);
			if (resolved) return resolved;
		}
		if (document.scriptClass) {
			return await this.findScriptByClassName(uri, document.scriptClass);
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
				const classScript = await this.findScriptByClassName(uri, base);
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

	/**
	 * Resolves `class_name` to its script without blocking the extension host.
	 *
	 * This used to recurse through the project with `readFileSync`, once per base
	 * class of every rebuilt model, which froze the editor while a `.tres` file
	 * was open. `ScriptClassNameIndex` caches the asynchronous scan.
	 */
	private async findScriptByClassName(contextUri: vscode.Uri, className: string): Promise<vscode.Uri | undefined> {
		return scriptClassNameIndex.find(className, contextUri);
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
				// The language server can be connected but wedged; an unanswered
				// request must never keep the inspector on its loading state.
				const symbol = (await withTimeout(
					sendRequest("textDocument/nativeSymbol", { native_class: resourceType, symbol_name: resourceType }),
					this.options.lspTimeoutMs ?? LSP_METADATA_TIMEOUT_MS,
					() => this.nativePropertiesCache.delete(resourceType),
				)) as {
					children?: Array<{ name?: string; detail?: string; kind?: number; hint?: string; hint_string?: string }>;
				} | undefined;
				const children = symbol?.children ?? [];
				const properties: LspPropertyInfo[] = [];
				for (const child of children) {
					if (!child.name) continue;
					const detail = child.detail ?? "";
					const type = detail.match(/\bvar\s+[\w.]+\s*:\s*([^=]+?)(?:\s*=|\s*$)/)?.[1]?.trim();
					if (/\bvar\s/.test(detail) || child.kind === 7 || child.kind === 8 || child.kind === 13) {
						const rawDefault = detail.match(/\s=\s*([\s\S]+)$/)?.[1]?.trim();
						properties.push({ name: child.name, type: type ?? "Variant", hint: child.hint, hint_string: child.hint_string,
							default_value: rawDefault && !parseVariant(rawDefault).error ? rawDefault : undefined });
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
		for (const timer of this.pendingModelUpdates.values()) clearTimeout(timer);
		this.pendingModelUpdates.clear();
		this.scriptWatcher.dispose();
		this.watcher.dispose();
		this.diagnostics.dispose();
	}
}

const LSP_METADATA_TIMEOUT_MS = 4_000;
/** Typing coalescing window for `.tres` model rebuilds. */
const MODEL_UPDATE_DEBOUNCE_MS = 120;

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
		if (path.isAbsolute(normalized) || /^[A-Za-z]:\//.test(normalized)) return vscode.Uri.file(normalized);
		if (/^[A-Za-z][A-Za-z0-9+.-]*:/.test(normalized)) return undefined;
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

const WEBVIEW_IMAGE_EXTENSIONS = new Set([".png", ".svg", ".jpg", ".jpeg", ".webp", ".gif", ".bmp", ".ico", ".avif"]);
const GODOT_IMAGE_EXTENSIONS = new Set([...WEBVIEW_IMAGE_EXTENSIONS, ".tga", ".dds", ".exr", ".hdr", ".ktx", ".ctex", ".stex"]);

function previewRoots(uri: vscode.Uri): vscode.Uri[] {
	const roots = [...(vscode.workspace.workspaceFolders ?? []).map((folder) => folder.uri), findProjectRoot(uri), vscode.Uri.joinPath(uri, "..")];
	return [...new Map(roots.filter((root): root is vscode.Uri => Boolean(root)).map((root) => [root.toString(), root])).values()];
}

function insidePreviewRoots(uri: vscode.Uri, roots: vscode.Uri[]): boolean {
	try {
		const filePath = fs.realpathSync(uri.fsPath);
		return roots.some((root) => {
			try {
				const relative = path.relative(fs.realpathSync(root.fsPath), filePath);
				return relative !== ".." && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative);
			} catch { return false; }
		});
	} catch {
		return false;
	}
}

function imagePreviewForPath(resourceUri: vscode.Uri, imagePath?: string, webview?: vscode.Webview): ImagePreview | undefined {
	if (!imagePath || !GODOT_IMAGE_EXTENSIONS.has(path.extname(imagePath).toLowerCase())) return undefined;
	const preview: ImagePreview = { path: imagePath };
	const uri = resolveResourceUri(resourceUri, imagePath);
	if (!uri || !fs.existsSync(uri.fsPath)) return { ...preview, message: "Image file is missing." };
	if (!WEBVIEW_IMAGE_EXTENSIONS.has(path.extname(imagePath).toLowerCase())) return { ...preview, message: "This image format cannot be previewed here. Open it in an image viewer." };
	if (!insidePreviewRoots(uri, previewRoots(resourceUri))) return { ...preview, message: "Inline previews are restricted to images inside this project or workspace." };
	return { ...preview, uri: webview?.asWebviewUri?.(uri).toString() };
}

/** Finds image paths in strings, external references and texture sub-resources. */
function imagePathForValue(raw: string, document: ResourceDocument, visited = new Set<string>()): string | undefined {
	const value = parseVariant(raw).value;
	if (value.kind === "ExtResource") return document.extResources.find((ext) => ext.id === value.referenceId)?.path;
	if (value.kind === "String" || value.kind === "StringName") return value.text;
	if (value.kind === "SubResource" && value.referenceId && !visited.has(value.referenceId)) {
		visited.add(value.referenceId);
		const sub = document.subResources.find((entry) => entry.id === value.referenceId);
		const source = sub?.properties.find((property) => property.name === "atlas" || property.name === "texture");
		return source && imagePathForValue(source.valueText, document, visited);
	}
	return undefined;
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

function extResourceType(uri: vscode.Uri, format?: string): string {
	const extension = path.extname(uri.fsPath).toLowerCase();
	switch (extension) {
		case ".gd": return "Script";
		case ".gdshader": return "Shader";
		case ".tscn": return "PackedScene";
		case ".tres": return "Resource";
		case ".png":
		case ".svg":
		case ".jpg":
		case ".jpeg":
		case ".gif":
		case ".bmp":
		case ".webp": return format === "2" ? "Texture" : "Texture2D";
		default: return "Resource";
	}
}

export function formatPropertyValue(value: string): string {
	return formatVariant(parseVariant(value).value);
}
