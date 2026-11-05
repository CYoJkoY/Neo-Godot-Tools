import * as fs from "node:fs";
import { dirname, isAbsolute, resolve } from "node:path";
import * as vscode from "vscode";
import {
	type CancellationToken,
	EventEmitter,
	type ExtensionContext,
	type FileDecoration,
	type TreeDataProvider,
	type TreeDragAndDropController,
	type TreeItem,
	TreeItemCollapsibleState,
	type TreeView,
	type Uri,
	window,
	workspace,
} from "vscode";
import type { LspClientLike } from "../lsp/types";
import {
	convert_resource_path_to_uri,
	createLogger,
	find_file,
	get_configuration,
	make_docs_uri,
	register_command,
	set_context,
} from "../utils";
import { apply_custom_class_icons, invalidateNodeIconCaches } from "./node_icons";
import { SceneParser } from "./parser";
import { NodePropertyMetadata } from "./property_editor";
import { type Scene, SceneNode } from "./types";
import { createScenePropertyInspector, type ScenePropertyInspector } from "./property_inspector.js";

export type SceneTreeElement = SceneNode;

const log = createLogger("scenes.preview");

export class ScenePreviewProvider
	implements TreeDataProvider<SceneTreeElement>, TreeDragAndDropController<SceneNode>, vscode.Disposable
{
	public dropMimeTypes = [];
	public dragMimeTypes = [];
	private tree: TreeView<SceneTreeElement>;
	private scenePreviewLocked = false;
	private currentScene = "";
	public parser = new SceneParser();
	public scene: Scene | undefined;
	watcher = workspace.createFileSystemWatcher("**/*.tscn");
	scriptWatcher = workspace.createFileSystemWatcher("**/*.gd");
	private refreshInFlight = false;
	private refreshQueued = false;
	private pendingSceneChanges = new Map<string, ReturnType<typeof setTimeout>>();
	uniqueDecorator = new UniqueDecorationProvider(this);
	scriptDecorator = new ScriptDecorationProvider(this);

	private changeTreeEvent = new EventEmitter<SceneNode | undefined>();
	onDidChangeTreeData = this.changeTreeEvent.event;

	private readonly nodeProperties: NodePropertyMetadata;
	private readonly propertyInspector: ScenePropertyInspector;

	constructor(
		private context: ExtensionContext,
		options: { lspClient?: () => LspClientLike | undefined } = {},
	) {
		this.tree = vscode.window.createTreeView("neoGodotTools.scenePreview", {
			treeDataProvider: this,
			dragAndDropController: this,
		});
		this.nodeProperties = new NodePropertyMetadata(options);
		this.propertyInspector = createScenePropertyInspector(context, this.parser, this.nodeProperties);

		context.subscriptions.push(
			register_command("scenePreview.lock", this.lock_preview.bind(this)),
			register_command("scenePreview.unlock", this.unlock_preview.bind(this)),
			register_command("scenePreview.copyNodePath", this.copy_node_path.bind(this)),
			register_command("scenePreview.copyResourcePath", this.copy_resource_path.bind(this)),
			register_command("scenePreview.openScene", this.open_scene.bind(this)),
			register_command("scenePreview.openScript", this.open_script.bind(this)),
			register_command("scenePreview.openCurrentScene", this.open_current_scene.bind(this)),
			register_command("scenePreview.openMainScript", this.open_main_script.bind(this)),
			register_command("scenePreview.goToDefinition", this.go_to_definition.bind(this)),
			register_command("scenePreview.openDocumentation", this.open_documentation.bind(this)),
			register_command("scenePreview.refresh", this.refresh.bind(this)),
			register_command("scenePreview.openPropertyInspector", (item?: SceneNode) =>
				this.open_property_inspector(item),
			),
			window.onDidChangeActiveTextEditor(this.text_editor_changed.bind(this)),
			window.registerFileDecorationProvider(this.uniqueDecorator),
			window.registerFileDecorationProvider(this.scriptDecorator),
			this.watcher.onDidChange(this.on_file_changed.bind(this)),
			this.watcher,
			// Custom class icons come from `class_name` declarations, so script
			// changes invalidate the cached scan instead of keeping stale icons.
			this.scriptWatcher.onDidCreate(() => invalidateNodeIconCaches()),
			this.scriptWatcher.onDidChange(() => invalidateNodeIconCaches()),
			this.scriptWatcher.onDidDelete(() => invalidateNodeIconCaches()),
			this.scriptWatcher,
			this.tree,
			{ dispose: () => this.dispose() },
		);
		const result: string | undefined = this.context.workspaceState.get("neoGodotTools.scenePreview.lockedScene");
		if (result) {
			if (fs.existsSync(result)) {
				set_context("scenePreview.locked", true);
				this.scenePreviewLocked = true;
				this.currentScene = result;
			}
		}

		if (this.scenePreviewLocked) {
			void this.refresh();
		} else {
			void this.text_editor_changed();
		}
	}

	/**
	 * Stops the debounced scene watcher.
	 *
	 * The timers keep the provider (and the extension host) busy after the user
	 * deactivated the extension or closed the window; a pending refresh would
	 * also try to parse a scene while VS Code is shutting down.
	 */
	dispose(): void {
		for (const timer of this.pendingSceneChanges.values()) clearTimeout(timer);
		this.pendingSceneChanges.clear();
		this.nodeProperties.clear();
		this.propertyInspector.dispose();
	}

	public refresh_property_inspector(): void {
		this.nodeProperties.clear();
		this.propertyInspector.refresh();
	}

	public handleDrag(
		source: readonly SceneNode[],
		data: vscode.DataTransfer,
		_token: vscode.CancellationToken,
	): void | Thenable<void> {
		if (source.length === 0) return;
		data.set("godot/scene", new vscode.DataTransferItem(this.currentScene));
		data.set("godot/node", new vscode.DataTransferItem(source[0]));
		data.set("godot/path", new vscode.DataTransferItem(source[0].path));
		data.set("godot/relativePath", new vscode.DataTransferItem(source[0].relativePath));
		data.set("godot/class", new vscode.DataTransferItem(source[0].className));
		data.set("godot/unique", new vscode.DataTransferItem(source[0].unique));
		data.set("godot/label", new vscode.DataTransferItem(source[0].label));
	}

	public async on_file_changed(uri: vscode.Uri) {
		if (!uri.fsPath.endsWith(".tscn")) {
			return;
		}
		// Editors write scenes in bursts (save, format-on-save, git operations).
		// Coalesce those events and run one parse per settle instead of a parse
		// per notification, each of which blocked the extension host.
		const pending = this.pendingSceneChanges.get(uri.fsPath);
		if (pending) clearTimeout(pending);
		this.pendingSceneChanges.set(
			uri.fsPath,
			setTimeout(() => {
				this.pendingSceneChanges.delete(uri.fsPath);
				void this.handle_scene_file_changed(uri);
			}, 150),
		);
	}

	private async handle_scene_file_changed(uri: vscode.Uri) {
		try {
			if (uri.fsPath === this.currentScene) {
				await this.refresh();
				return;
			}
			const document = await vscode.workspace.openTextDocument(uri);
			this.parser.parse_scene(document);
		} catch (error) {
			log.debug(`Unable to refresh changed scene ${uri.fsPath}: ${String(error)}`);
		}
	}

	public async text_editor_changed() {
		if (this.scenePreviewLocked) {
			return;
		}
		const editor = vscode.window.activeTextEditor;
		if (editor) {
			let fileName = editor.document.uri.fsPath;
			const mode = get_configuration("scenePreview.previewRelatedScenes");
			if (!fileName.endsWith(".tscn")) {
				const searchName = fileName.replace(".gd", ".tscn").replace(".cs", ".tscn");

				if (mode === "anyFolder") {
					const relatedScene = await find_file(searchName);
					if (!relatedScene) {
						return;
					}
					fileName = relatedScene.fsPath;
				}

				if (mode === "sameFolder") {
					if (fs.existsSync(searchName)) {
						fileName = searchName;
					} else {
						return;
					}
				}
				if (mode === "off") {
					return;
				}
			}
			if (!fileName.endsWith(".tscn")) {
				return;
			}

			this.currentScene = fileName;
			this.refresh();
		}
	}

	public async refresh() {
		// Scene refreshes are triggered by editor switches, file watchers and the
		// refresh command; overlapping runs used to stack parses on the extension
		// host. Keep one run in flight and coalesce the rest.
		if (this.refreshInFlight) {
			this.refreshQueued = true;
			return;
		}
		this.refreshInFlight = true;
		try {
			await this.apply_refresh();
		} catch (error) {
			log.debug(`Scene Preview refresh failed: ${String(error)}`);
		} finally {
			this.refreshInFlight = false;
			if (this.refreshQueued) {
				this.refreshQueued = false;
				void this.refresh();
			}
		}
	}

	private async apply_refresh() {
		if (!this.currentScene || !fs.existsSync(this.currentScene)) {
			return;
		}

		const document = await vscode.workspace.openTextDocument(this.currentScene);
		this.scene = this.parser.parse_scene(document);

		if (this.scene) {
			try {
				await apply_custom_class_icons(this.scene);
			} catch (error) {
				console.warn("[ScenePreview] icon resolution failed", error);
			}
		}

		this.tree.message = this.scene?.title ?? "";

		this.changeTreeEvent.fire(undefined);
	}

	private lock_preview() {
		this.scenePreviewLocked = true;
		set_context("scenePreview.locked", true);
		this.context.workspaceState.update("neoGodotTools.scenePreview.lockedScene", this.currentScene);
	}

	private unlock_preview() {
		this.scenePreviewLocked = false;
		set_context("scenePreview.locked", false);
		this.context.workspaceState.update("neoGodotTools.scenePreview.lockedScene", "");
		this.refresh();
	}

	private copy_node_path(item: SceneNode) {
		if (item.unique) {
			vscode.env.clipboard.writeText(`%${item.label}`);
			return;
		}
		vscode.env.clipboard.writeText(item.relativePath);
	}

	private copy_resource_path(item: SceneNode) {
		if (!item.resourcePath) return;
		void vscode.env.clipboard.writeText(item.resourcePath);
	}

	private async open_scene(item: SceneNode) {
		if (!item.resourcePath) return;
		const uri = await convert_resource_path_to_uri(item.resourcePath);
		await vscode.window.showTextDocument(uri, { preview: true });
	}

	private async open_script(item: SceneNode) {
		const resource = this.resolve_script_resource(this.scene, item);
		if (!resource?.path) {
			log.debug(`No script resource found for Scene Preview node '${item.path}'.`);
			return;
		}

		const uri = this.resolve_resource_uri(this.scene?.path, resource.path);
		if (!uri) {
			log.debug(`Unable to resolve script resource path '${resource.path}' for '${item.path}'.`);
			return;
		}
		await vscode.window.showTextDocument(uri, { preview: true });
	}

	private resolve_script_resource(scene: Scene | undefined, item: SceneNode): { path: string } | undefined {
		if (!scene) return undefined;

		const findDirect = (source: Scene, node: SceneNode): { path: string } | undefined => {
			if (node.scriptId) {
				const resource = source.externalResources.get(node.scriptId);
				if (resource?.path) return resource;
			}

			if (node.customTypeScriptId) {
				const resource = source.externalResources.get(node.customTypeScriptId);
				if (resource?.path) return resource;
			}

			if (node.customTypeScriptUid) {
				const resource = source.externalResourcesByUid.get(node.customTypeScriptUid);
				if (resource?.path) return resource;
			}

			if (node.customTypeScriptSubResourceId) {
				const subResource = source.subResources.get(node.customTypeScriptSubResourceId);
				const scriptId = subResource?.body.match(
					/(?:^|\n)script\s*=\s*ExtResource\(\s*"?([^\)"\s]+)"?\s*\)/,
				)?.[1];
				if (scriptId) {
					const resource = source.externalResources.get(scriptId);
					if (resource?.path) return resource;
				}
			}
			return undefined;
		};

		const visited = new Set<string>();
		const visit = (currentScene: Scene, currentNode: SceneNode): { path: string } | undefined => {
			const key = `${currentScene.path}:${currentNode.path}`;
			if (visited.has(key)) return undefined;
			visited.add(key);

			const direct = findDirect(currentScene, currentNode);
			if (direct) return direct;

			if (currentNode.instanceScene?.root) {
				const nested = visit(currentNode.instanceScene, currentNode.instanceScene.root);
				if (nested) return nested;
			}
			return undefined;
		};

		return visit(scene, item);
	}

	private resolve_resource_uri(scenePath: string | undefined, resourcePath: string): vscode.Uri | undefined {
		if (!scenePath || !resourcePath) return undefined;

		if (resourcePath.startsWith("res://")) {
			const folder = vscode.workspace.getWorkspaceFolder(vscode.Uri.file(scenePath));
			if (!folder) return undefined;
			const filePath = resolve(folder.uri.fsPath, resourcePath.slice("res://".length));
			return fs.existsSync(filePath) ? vscode.Uri.file(filePath) : undefined;
		}

		if (resourcePath.startsWith("user://")) return undefined;

		const filePath = isAbsolute(resourcePath) ? resourcePath : resolve(dirname(scenePath), resourcePath);
		return fs.existsSync(filePath) ? vscode.Uri.file(filePath) : undefined;
	}

	private async open_current_scene() {
		if (this.currentScene) {
			const document = await vscode.workspace.openTextDocument(this.currentScene);
			vscode.window.showTextDocument(document);
		}
	}

	private async open_main_script() {
		const root = this.scene?.root;
		if (!this.scene || !root) {
			return;
		}

		const resource = this.resolve_script_resource(this.scene, root);
		if (!resource?.path) {
			log.debug(`No main script found for Scene Preview scene '${this.scene.path}'.`);
			return;
		}

		const uri = this.resolve_resource_uri(this.scene.path, resource.path);
		if (!uri) {
			log.debug(`Unable to resolve main script resource path '${resource.path}' for scene '${this.scene.path}'.`);
			return;
		}
		await vscode.window.showTextDocument(uri, { preview: true });
	}

	private async go_to_definition(item: SceneNode) {
		const document = await vscode.workspace.openTextDocument(this.currentScene);
		const start = document.positionAt(item.position);
		const end = document.positionAt(item.position + item.text.length);
		const range = new vscode.Range(start, end);
		vscode.window.showTextDocument(document, { selection: range });
	}

	private async open_documentation(item: SceneNode) {
		vscode.commands.executeCommand("vscode.open", make_docs_uri(item.className));
	}

	private get_scene_children(element?: SceneNode): SceneNode[] {
		if (!this.scene?.root) return [];
		return element ? element.children : [this.scene.root];
	}

	public async getChildren(element?: SceneTreeElement): Promise<SceneTreeElement[]> {
		if (!element) return this.get_scene_children();
		return this.get_scene_children(element);
	}

	public getTreeItem(element: SceneTreeElement): TreeItem | Thenable<TreeItem> {
		if (this.get_scene_children(element).length > 0) {
			element.collapsibleState = TreeItemCollapsibleState.Expanded;
		} else {
			element.collapsibleState = TreeItemCollapsibleState.None;
		}
		// A stable id keeps the tree expanded across refreshes, which happen on
		// every scene save and every property edit.
		element.id = `node:${element.path}`;

		if (element.resourceUri) {
			this.uniqueDecorator.update(element.resourceUri);
			this.scriptDecorator.update(element.resourceUri);
		}

		return element;
	}

	/** Opens the dedicated property editor for the node the inline pencil edited. */
	private async open_property_inspector(item?: SceneNode) {
		const node = item;
		const scenePath = this.currentScene || this.scene?.path;
		if (!node || !scenePath) return;
		await this.propertyInspector.open(vscode.Uri.file(scenePath), node.path);
	}
}

class UniqueDecorationProvider implements vscode.FileDecorationProvider {
	public emitter = new EventEmitter<Uri>();
	onDidChangeFileDecorations = this.emitter.event;

	update(uri: Uri) {
		this.emitter.fire(uri);
	}

	constructor(private previewer: ScenePreviewProvider) {}

	provideFileDecoration(uri: Uri, _token: CancellationToken): FileDecoration | undefined {
		if (uri.scheme !== "godot") return undefined;
		const node = this.previewer.scene?.nodes.get(uri.path);
		return node?.unique ? { badge: "%" } : undefined;
	}
}

class ScriptDecorationProvider implements vscode.FileDecorationProvider {
	public emitter = new EventEmitter<Uri>();
	onDidChangeFileDecorations = this.emitter.event;

	update(uri: Uri) {
		this.emitter.fire(uri);
	}

	constructor(private previewer: ScenePreviewProvider) {}

	provideFileDecoration(uri: Uri, _token: CancellationToken): FileDecoration | undefined {
		if (uri.scheme !== "godot") return undefined;
		const node = this.previewer.scene?.nodes.get(uri.path);
		return node?.hasScript ? { badge: "S" } : undefined;
	}
}
