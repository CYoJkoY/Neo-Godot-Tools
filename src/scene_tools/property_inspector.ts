import * as path from "node:path";
import * as vscode from "vscode";
import { PropertyMetadata, defaultValueForType, widgetForProperty } from "../resource_inspector/metadata.js";
import { resourceInspectorHtml } from "../resource_inspector/panel_html.js";
import { parseVariant } from "../resource_inspector/values.js";
import { convert_resource_path_to_uri, convert_uri_to_resource_path, convert_uid_to_uri, createLogger } from "../utils";
import { SceneParser } from "./parser.js";
import { NodePropertyMetadata, applyScenePropertyWrite, applySceneResourcePropertyWrite } from "./property_editor.js";
import {
	addSceneExternalResource,
	addSceneSubResource,
	replaceSceneArrayItem,
	sceneExternalResourceType,
	sceneFormat,
	sceneResourceReference,
} from "./resources.js";
import type { Scene, SceneNode } from "./types.js";

const log = createLogger("scenes.propertyInspector");

interface InspectorTarget {
	uri: vscode.Uri;
	nodePath: string;
}

interface InspectorMessage {
	command?: string;
	name?: string;
	value?: string;
	target?: string;
	id?: string;
	index?: number;
	subType?: string;
}

interface InspectorPropertyModel {
	name: string;
	valueText: string;
	raw: string;
	target: string;
	definedInFile: boolean;
	modified: boolean;
	components?: number[];
	constructorName?: string;
	metadata?: PropertyMetadata;
	widget: ReturnType<typeof widgetForProperty>;
}

export interface ScenePropertyInspector {
	open(uri: vscode.Uri, nodePath: string): Promise<void>;
	refresh(): void;
	dispose(): void;
}

interface InspectorState {
	panel: vscode.WebviewPanel | undefined;
	target: InspectorTarget | undefined;
	generation: number;
	pendingRefresh: ReturnType<typeof setTimeout> | undefined;
}

/** Opens a standalone, resource-inspector-style editor for one `.tscn` node. */
export function createScenePropertyInspector(
	context: vscode.ExtensionContext,
	parser: SceneParser,
	nodeProperties: NodePropertyMetadata,
): ScenePropertyInspector {
	const state: InspectorState = { panel: undefined, target: undefined, generation: 0, pendingRefresh: undefined };
	const sceneWatcher = vscode.workspace.createFileSystemWatcher("**/*.tscn");
	const disposables: vscode.Disposable[] = [
		vscode.workspace.onDidChangeTextDocument((event) => {
			if (event.document.uri.toString() === state.target?.uri.toString()) scheduleRefresh();
		}),
		sceneWatcher.onDidChange((uri) => {
			if (uri.fsPath === state.target?.uri.fsPath) scheduleRefresh();
		}),
		sceneWatcher.onDidCreate((uri) => {
			if (uri.fsPath === state.target?.uri.fsPath) scheduleRefresh();
		}),
		sceneWatcher,
	];

	function scheduleRefresh(): void {
		if (state.pendingRefresh) clearTimeout(state.pendingRefresh);
		state.pendingRefresh = setTimeout(() => {
			state.pendingRefresh = undefined;
			void refresh();
		}, 120);
	}

	function title(scene: Scene, node: SceneNode): string {
		return `Scene Properties: ${node.path} — ${path.basename(scene.path)}`;
	}

	function createPanel(scene: Scene, node: SceneNode): vscode.WebviewPanel {
		const panel = vscode.window.createWebviewPanel(
			"neoGodotTools.scenePropertyInspector",
			title(scene, node),
			vscode.ViewColumn.Beside,
			{ enableScripts: true, retainContextWhenHidden: true },
		);
		panel.webview.html = resourceInspectorHtml(panel.webview, context.extensionUri);
		panel.webview.onDidReceiveMessage((message: InspectorMessage) => void onMessage(message));
		panel.onDidDispose(() => {
			if (state.panel !== panel) return;
			state.panel = undefined;
			state.target = undefined;
			state.generation++;
		});
		context.subscriptions.push(panel);
		return panel;
	}

	async function open(uri: vscode.Uri, nodePath: string): Promise<void> {
		const document = await vscode.workspace.openTextDocument(uri);
		const scene = parser.parse_scene(document);
		const node = scene.nodes.get(nodePath);
		if (!node || node.position < 0 || node.bodyEnd < 0) {
			void vscode.window.showInformationMessage(
				"This node is inherited from an instanced scene and cannot be edited in the current scene.",
			);
			return;
		}

		state.target = { uri, nodePath };
		const existingPanel = state.panel;
		if (!existingPanel) state.panel = createPanel(scene, node);
		const panel = state.panel;
		if (!panel) return;
		panel.title = title(scene, node);
		if (existingPanel) panel.reveal(vscode.ViewColumn.Beside, true);
		await refresh();
	}

	async function onMessage(message: InspectorMessage): Promise<void> {
		const target = state.target;
		if (!target) return;
		try {
			switch (message.command) {
				case "ready":
				case "reload":
					await refresh();
					return;
				case "openText": {
					const document = await vscode.workspace.openTextDocument(target.uri);
					await vscode.window.showTextDocument(document, { preview: false, preserveFocus: true });
					return;
				}
				case "setProperty":
					if (message.name && message.value !== undefined)
						await writeProperty(target, message.target, message.name, message.value);
					return;
				case "revertProperty":
					if (message.name) await writeProperty(target, message.target, message.name, null);
					return;
				case "pickResource":
					if (message.name) await pickResource(target, message.target, message.name);
					return;
				case "pickArrayResource":
					if (message.name && message.index !== undefined)
						await pickResource(target, message.target, message.name, message.index);
					return;
				case "createSubResource":
					if (message.name) await createSubResource(target, message.target, message.name, message.subType);
					return;
				case "createArraySubResource":
					if (message.name && message.index !== undefined)
						await createSubResource(target, message.target, message.name, message.subType, message.index);
					return;
				case "openExtResource":
					if (message.id) await openExternalResource(target, message.id);
					return;
				default:
					return;
			}
		} catch (error) {
			log.error(`Scene property edit failed: ${String(error)}`);
			void vscode.window.showErrorMessage(`Unable to edit the scene property: ${String(error)}`);
		}
	}

	async function refresh(): Promise<void> {
		const target = state.target;
		const panel = state.panel;
		if (!target || !panel) return;
		const generation = ++state.generation;
		try {
			const document = await vscode.workspace.openTextDocument(target.uri);
			const version = document.version;
			const scene = parser.parse_scene(document);
			const node = scene.nodes.get(target.nodePath);
			if (!node || node.position < 0 || node.bodyEnd < 0) {
				void panel.webview.postMessage({ type: "empty" });
				return;
			}
			const metadata = await nodeProperties.forNode(scene, node);
			const properties = propertyModels(node.properties, metadata, `node:${node.path}`);
			const subResources = await Promise.all(
				[...scene.subResources.values()].map(async (resource) => ({
					id: resource.id,
					type: resource.type,
					properties: propertyModels(
						resource.properties,
						await nodeProperties.forClass(resource.type),
						`sub:${resource.id}`,
					),
				})),
			);
			if (
				state.generation !== generation ||
				state.panel !== panel ||
				state.target?.uri.toString() !== target.uri.toString() ||
				state.target?.nodePath !== target.nodePath ||
				document.version !== version
			)
				return;

			const model = {
				uri: document.uri.toString(),
				fileName: path.basename(document.uri.fsPath || document.uri.path),
				resourcePath: document.uri.fsPath,
				nodeName: node.label,
				nodePath: node.path,
				scenePath: path.basename(scene.path),
				version,
				resourceType: node.className || "Node",
				scriptClass: undefined,
				format: sceneFormat(document.getText()),
				properties,
				subResources,
				subResourceTypes: [...scene.subResources.values()].map(({ id, type }) => ({ id, type })),
				extResources: [...scene.externalResources.values()].map((resource) => ({
					id: resource.id,
					type: resource.type,
					path: resource.path,
					uid: resource.uid,
					broken: false,
				})),
				diagnostics: [],
				editorKind: "sceneNode",
				locked: false,
			};
			void panel.webview.postMessage({ type: "model", model });
		} catch (error) {
			log.debug(`Unable to refresh scene inspector: ${String(error)}`);
		}
	}

	async function writeProperty(
		target: InspectorTarget,
		resourceTarget: string | undefined,
		name: string,
		value: string | null,
	): Promise<void> {
		const document = await vscode.workspace.openTextDocument(target.uri);
		const scene = parser.parse_scene(document);
		if (resourceTarget?.startsWith("sub:")) {
			const resource = scene.subResources.get(resourceTarget.slice("sub:".length));
			if (!resource) return;
			await applySceneResourcePropertyWrite(document, scene, resource, name, value);
			return;
		}
		const nodePath = resourceTarget?.startsWith("node:") ? resourceTarget.slice("node:".length) : target.nodePath;
		const node = scene.nodes.get(nodePath);
		if (!node) return;
		await applyScenePropertyWrite(document, scene, node, name, value);
	}

	async function pickResource(
		target: InspectorTarget,
		resourceTarget: string | undefined,
		name: string,
		arrayIndex?: number,
	): Promise<void> {
		const document = await vscode.workspace.openTextDocument(target.uri);
		const scene = parser.parse_scene(document);
		const metadata = await metadataForTarget(scene, target.nodePath, resourceTarget, name);
		const expected = metadata?.type?.match(/^Array\[([^\]]+)\]$/)?.[1] ?? metadata?.type;
		const extensions = resourceExtensions(expected);
		const picked = await vscode.window.showOpenDialog({
			canSelectMany: false,
			defaultUri: vscode.Uri.file(path.dirname(target.uri.fsPath)),
			filters: { "Godot resources": extensions },
		});
		if (!picked?.length) return;
		const latest = await vscode.workspace.openTextDocument(target.uri);
		const text = latest.getText();
		const relativePath = await scenePathForUri(target.uri, picked[0]);
		const fallback = expected && expected !== "Array" && expected !== "Variant" ? expected : "Resource";
		const source =
			path.extname(picked[0].fsPath).toLowerCase() === ".tres" ? await readResourceText(picked[0]) : undefined;
		const type = sceneExternalResourceType(picked[0].fsPath, sceneFormat(text), source, fallback);
		const added = addSceneExternalResource(text, { type, path: relativePath });
		await replaceDocumentText(latest, added.text);
		if (!added.id) return;
		const reference = sceneResourceReference("Ext", added.id, added.text);
		if (arrayIndex === undefined) {
			await writeProperty(target, resourceTarget, name, reference);
			return;
		}
		const currentScene = parser.parse_scene(await vscode.workspace.openTextDocument(target.uri));
		const property = propertyForTarget(currentScene, target.nodePath, resourceTarget, name);
		const updated = property && replaceSceneArrayItem(property.raw, arrayIndex, reference);
		if (updated !== undefined) await writeProperty(target, resourceTarget, name, updated);
	}

	async function createSubResource(
		target: InspectorTarget,
		resourceTarget: string | undefined,
		name: string,
		type = "Resource",
		arrayIndex?: number,
	): Promise<void> {
		const document = await vscode.workspace.openTextDocument(target.uri);
		const added = addSceneSubResource(document.getText(), { type });
		if (!added.changed || !added.id) return;
		await replaceDocumentText(document, added.text);
		const reference = sceneResourceReference("Sub", added.id, added.text);
		if (arrayIndex === undefined) {
			await writeProperty(target, resourceTarget, name, reference);
			return;
		}
		const scene = parser.parse_scene(await vscode.workspace.openTextDocument(target.uri));
		const property = propertyForTarget(scene, target.nodePath, resourceTarget, name);
		const updated = property && replaceSceneArrayItem(property.raw, arrayIndex, reference);
		if (updated !== undefined) await writeProperty(target, resourceTarget, name, updated);
	}

	async function metadataForTarget(
		scene: Scene,
		nodePath: string,
		resourceTarget: string | undefined,
		name: string,
	): Promise<PropertyMetadata | undefined> {
		if (resourceTarget?.startsWith("sub:")) {
			const resource = scene.subResources.get(resourceTarget.slice("sub:".length));
			return (
				resource && (await nodeProperties.forClass(resource.type)).find((property) => property.name === name)
			);
		}
		const node = scene.nodes.get(nodePath);
		return node && (await nodeProperties.forNode(scene, node)).find((property) => property.name === name);
	}

	function propertyForTarget(
		scene: Scene,
		nodePath: string,
		resourceTarget: string | undefined,
		name: string,
	): { raw: string } | undefined {
		if (resourceTarget?.startsWith("sub:")) {
			return scene.subResources
				.get(resourceTarget.slice("sub:".length))
				?.properties.find((entry) => entry.name === name);
		}
		return scene.nodes.get(nodePath)?.properties.find((entry) => entry.name === name);
	}

	async function replaceDocumentText(document: vscode.TextDocument, text: string): Promise<void> {
		const previous = document.getText();
		if (previous === text) return;
		const start = commonPrefixLength(previous, text);
		const suffixLength = commonSuffixLength(previous, text, Math.min(previous.length - start, text.length - start));
		const previousEnd = previous.length - suffixLength;
		const nextEnd = text.length - suffixLength;
		const edit = new vscode.WorkspaceEdit();
		edit.replace(
			document.uri,
			new vscode.Range(document.positionAt(start), document.positionAt(previousEnd)),
			text.slice(start, nextEnd),
		);
		await vscode.workspace.applyEdit(edit);
	}

	async function openExternalResource(target: InspectorTarget, id: string): Promise<void> {
		const document = await vscode.workspace.openTextDocument(target.uri);
		const scene = parser.parse_scene(document);
		const resource = scene.externalResources.get(id);
		if (!resource?.path) return;
		const uri = await externalResourceUri(target, resource.path);
		if (!uri) return;
		const external = await vscode.workspace.openTextDocument(uri);
		await vscode.window.showTextDocument(external, { preview: true, preserveFocus: true });
	}

	function refreshInspector(): void {
		if (state.panel) void refresh();
	}

	function dispose(): void {
		if (state.pendingRefresh) clearTimeout(state.pendingRefresh);
		vscode.Disposable.from(...disposables).dispose();
		state.panel?.dispose();
	}

	return { open, refresh: refreshInspector, dispose };
}

function commonPrefixLength(left: string, right: string, low = 0, high = Math.min(left.length, right.length)): number {
	if (low >= high) return low;
	const middle = Math.ceil((low + high) / 2);
	return left.slice(0, middle) === right.slice(0, middle)
		? commonPrefixLength(left, right, middle, high)
		: commonPrefixLength(left, right, low, middle - 1);
}

function commonSuffixLength(left: string, right: string, maximum: number, low = 0, high = maximum): number {
	if (low >= high) return low;
	const middle = Math.ceil((low + high) / 2);
	return left.slice(left.length - middle) === right.slice(right.length - middle)
		? commonSuffixLength(left, right, maximum, middle, high)
		: commonSuffixLength(left, right, maximum, low, middle - 1);
}

async function readResourceText(uri: vscode.Uri): Promise<string | undefined> {
	try {
		return (await vscode.workspace.openTextDocument(uri)).getText();
	} catch {
		return undefined;
	}
}

async function externalResourceUri(target: InspectorTarget, resourcePath: string): Promise<vscode.Uri | undefined> {
	try {
		return resourcePath.startsWith("uid://")
			? await convert_uid_to_uri(resourcePath)
			: resourcePath.startsWith("res://")
				? await convert_resource_path_to_uri(resourcePath)
				: vscode.Uri.file(
						path.isAbsolute(resourcePath)
							? resourcePath
							: path.resolve(path.dirname(target.uri.fsPath), resourcePath),
					);
	} catch {
		return undefined;
	}
}

function propertyModels(
	entries: readonly { name: string; raw: string }[],
	metadata: readonly PropertyMetadata[],
	target: string,
): InspectorPropertyModel[] {
	const known = new Map(metadata.map((property) => [property.name, property]));
	const present = new Set(entries.map((entry) => entry.name));
	return [
		...entries.map((entry) => createPropertyModel(entry.name, entry.raw, known.get(entry.name), target, true)),
		...metadata
			.filter((property) => !present.has(property.name))
			.map((property) =>
				createPropertyModel(
					property.name,
					property.defaultValue ?? defaultValueForType(property.type),
					property,
					target,
					false,
				),
			),
	];
}

function createPropertyModel(
	name: string,
	raw: string,
	metadata: PropertyMetadata | undefined,
	target: string,
	definedInFile: boolean,
): InspectorPropertyModel {
	const parsed = parseVariant(raw).value;
	return {
		name,
		valueText: raw,
		raw,
		target,
		definedInFile,
		modified: definedInFile,
		components: parsed.components,
		constructorName: parsed.typeName ?? parsed.kind,
		metadata,
		widget: widgetForProperty(metadata, parsed),
	};
}

function resourceExtensions(type: string | undefined): string[] {
	switch (type) {
		case "Script":
			return ["gd"];
		case "Shader":
			return ["gdshader"];
		case "PackedScene":
			return ["tscn"];
		default:
			return [
				"tres",
				"res",
				"tscn",
				"gd",
				"gdshader",
				"png",
				"svg",
				"jpg",
				"jpeg",
				"webp",
				"gif",
				"bmp",
				"wav",
				"ogg",
				"mp3",
				"flac",
				"ttf",
				"otf",
				"woff2",
				"mesh",
				"obj",
				"glb",
				"gltf",
			];
	}
}

async function scenePathForUri(sceneUri: vscode.Uri, resourceUri: vscode.Uri): Promise<string> {
	try {
		const resourcePath = await convert_uri_to_resource_path(resourceUri);
		if (!resourcePath.includes("../")) return resourcePath;
	} catch {
		/* fall back to a path relative to the scene */
	}
	const relative = path.relative(path.dirname(sceneUri.fsPath), resourceUri.fsPath).split(path.sep).join("/");
	return relative.startsWith(".") ? relative : `./${relative}`;
}
