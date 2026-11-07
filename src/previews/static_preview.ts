import * as fs from "node:fs";
import * as path from "node:path";
import * as vscode from "vscode";
import { parseShaderUniforms } from "../resource_inspector/metadata.js";
import { type VariantValue, parseVariant } from "../resource_inspector/values.js";
import { SceneParser } from "../scene_tools/parser.js";
import { Scene, SceneNode } from "../scene_tools/types.js";
import { createLruCache } from "../utils/lru_cache.js";
import { type GodotRenderer, createGodotRenderer, describeRenderError } from "./godot_render_service.js";
import { analyzeShaderSource } from "./shader_analysis.js";

export const SCENE_2D_PREVIEW_VIEW_TYPE = "neoGodotTools.scene2dPreview";
export const SHADER_PREVIEW_VIEW_TYPE = "neoGodotTools.shaderPreview";
const PREVIEW_UPDATE_DELAY_MS = 16;
const NATIVE_RENDER_DEBOUNCE_MS = 500;
const NATIVE_RENDER_WIDTH = 960;
const NATIVE_RENDER_HEIGHT = 540;

interface PreviewNode {
	path: string;
	className: string;
	label: string;
	position: number;
	x: number;
	y: number;
	width: number;
	height: number;
	rotation: number;
	scaleX: number;
	scaleY: number;
	color: string;
	text?: string;
	texturePath?: string;
	textureUri?: string;
	properties: Array<{ name: string; value: string }>;
	children: PreviewNode[];
}

interface ScenePreviewModel {
	kind: "scene";
	uri: string;
	title: string;
	nodes: PreviewNode[];
	warnings: string[];
	error?: string;
}

interface ShaderPreviewModel {
	kind: "shader";
	uri: string;
	shaderType: string;
	renderModes: string[];
	uniforms: Array<{ name: string; type: string; defaultValue?: string; hint?: string; hintString?: string }>;
	functions: string[];
	lineCount: number;
	diagnostics: Array<{ message: string; line: number }>;
	warnings: string[];
}

interface ScenePreviewResources {
	textureUri(imagePath: string): string | undefined;
}

interface PreviewMessage {
	command?: string;
	position?: number;
}

export function isPreviewMessage(value: unknown): value is PreviewMessage {
	if (typeof value !== "object" || value === null) return false;
	const message = value as Record<string, unknown>;
	if (message["command"] === "ready" || message["command"] === "openGodot") return true;
	return message["command"] === "openSource" && Number.isInteger(message["position"]);
}

type PreviewModel = ScenePreviewModel | ShaderPreviewModel;
type PreviewKind = PreviewModel["kind"];

function previewKind(uri: vscode.Uri): PreviewKind | undefined {
	const lower = uri.path.toLowerCase();
	if (lower.endsWith(".tscn")) return "scene";
	if (/\.(?:gdshader|shader|gdshaderinc)$/.test(lower)) return "shader";
	return undefined;
}

/** Godot can only show a meaningful surface for these shader stages here. */
export function nativeRenderSupport(
	kind: PreviewKind,
	uriPath: string,
	text: string,
): { supported: true } | { supported: false; message: string } {
	if (kind !== "shader") return { supported: true };
	if (uriPath.toLowerCase().endsWith(".gdshaderinc"))
		return {
			supported: false,
			message: "Shader include files have no standalone output. Showing declarations only.",
		};
	const analysis = analyzeShaderSource(text);
	if (!/^\s*shader_type\s+/m.test(analysis.cleanSource))
		return { supported: false, message: "Add a shader_type declaration to render this file with Godot." };
	if (analysis.shaderType !== "canvas_item" && analysis.shaderType !== "spatial" && analysis.shaderType !== "sky")
		return {
			supported: false,
			message: `Godot needs scene geometry for ${analysis.shaderType} shaders. Showing declarations only. Canvas, spatial, and sky shaders render natively.`,
		};
	return { supported: true };
}

export function createStaticPreviewProvider(context: vscode.ExtensionContext): vscode.CustomTextEditorProvider {
	const panels = new Map<string, Set<vscode.WebviewPanel>>();
	const readyPanels = new Set<vscode.WebviewPanel>();
	const parser = new SceneParser();
	const sceneCache = createLruCache<string, { version: number; scene: Scene }>({ capacity: 32 });
	const shaderCache = createLruCache<string, { version: number; model: ShaderPreviewModel }>({ capacity: 32 });
	const pendingUpdates = new Map<string, { document: vscode.TextDocument; timer: ReturnType<typeof setTimeout> }>();
	const renderStates = new Map<vscode.WebviewPanel, { token: number; timer?: ReturnType<typeof setTimeout> }>();
	const renderer = createPreviewRenderer(context);
	const isPreviewDocument = (document: vscode.TextDocument): boolean => previewKind(document.uri) !== undefined;
	const previewRoots = (documentUri: vscode.Uri): vscode.Uri[] => {
		const roots = vscode.workspace.workspaceFolders?.map((folder) => folder.uri) ?? [];
		const project = findProjectRoot(documentUri);
		if (project && !roots.some((root) => root.toString() === project.toString())) roots.push(project);
		if (renderer) roots.push(vscode.Uri.file(renderer.storageDirectory));
		return roots;
	};
	const html = (webview: vscode.Webview): string => {
		const nonce = createNonce();
		return `<!doctype html><html><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width, initial-scale=1"><meta http-equiv="Content-Security-Policy" content="default-src 'none'; img-src ${webview.cspSource} https: data:; style-src ${webview.cspSource} 'unsafe-inline'; script-src 'nonce-${nonce}'"><style>${STATIC_PREVIEW_CSS}</style></head><body><header><strong id="title">Preview</strong><span id="meta"></span><nav aria-label="Preview controls"><button id="openSource" type="button">Open source</button><button id="openGodot" type="button">Open in Godot</button><button id="fit" type="button">Fit</button><button id="zoomOut" type="button">-</button><span id="zoomLabel">100%</span><button id="zoomIn" type="button">+</button></nav></header><main><div id="canvas" aria-label="Static preview" tabindex="0"><section class="status" role="status"><h2>Preparing preview</h2><p>Building a static preview. Project scripts are not executed.</p></section></div><aside id="details"></aside></main><script nonce="${nonce}">${STATIC_PREVIEW_SCRIPT}</script></body></html>`;
	};
	const buildModel = (document: vscode.TextDocument, webview?: vscode.Webview): PreviewModel | undefined => {
		if (previewKind(document.uri) === "shader") {
			const key = document.uri.toString();
			const cached = shaderCache.get(key);
			if (cached?.version === document.version) return cached.model;
			const model = buildShaderPreviewModel(document.getText(), document.uri);
			shaderCache.set(key, { version: document.version, model });
			return model;
		}
		if (previewKind(document.uri) !== "scene") return undefined;
		try {
			const key = document.uri.toString();
			const cached = sceneCache.get(key);
			const scene = cached?.version === document.version ? cached.scene : parser.parse_scene(document);
			if (cached?.version !== document.version) sceneCache.set(key, { version: document.version, scene });
			return buildScenePreviewModel(scene, webview);
		} catch (error: unknown) {
			return {
				kind: "scene",
				uri: document.uri.toString(),
				title: path.basename(document.uri.fsPath || document.uri.path),
				nodes: [],
				error: String(error),
				warnings: [`Unable to parse scene: ${String(error)}`],
			};
		}
	};
	const sendModel = (document: vscode.TextDocument, panel: vscode.WebviewPanel): void => {
		if (!readyPanels.has(panel)) return;
		const model = buildModel(document, panel.webview);
		if (!model) return;
		panel.webview.options = { ...panel.webview.options, localResourceRoots: previewRoots(document.uri) };
		void panel.webview.postMessage({ type: "model", model, dirty: document.isDirty });
	};
	const postRenderState = (panel: vscode.WebviewPanel, message: Record<string, unknown>): void => {
		void panel.webview.postMessage({ type: "render", ...message });
	};
	const requestRender = (document: vscode.TextDocument, panel: vscode.WebviewPanel, delayMs: number): void => {
		const kind = previewKind(document.uri);
		if (kind === undefined) return;
		const state = renderStates.get(panel) ?? { token: 0, timer: undefined };
		renderStates.set(panel, state);
		state.token += 1;
		const token = state.token;
		if (state.timer !== undefined) clearTimeout(state.timer);
		state.timer = undefined;
		const approximate = document.isDirty;
		const support = nativeRenderSupport(kind, document.uri.path, document.getText());
		if (!support.supported) {
			postRenderState(panel, { state: "unavailable", approximate, message: support.message });
			return;
		}
		const activeRenderer = renderer;
		if (!activeRenderer) {
			postRenderState(panel, {
				state: "unavailable",
				approximate,
				message: "Native Godot rendering is not available in this window.",
			});
			return;
		}
		if (document.uri.scheme !== "file") {
			postRenderState(panel, {
				state: "unavailable",
				approximate,
				message: "Save this file inside a Godot project to render it with Godot.",
			});
			return;
		}
		postRenderState(panel, { state: "rendering", approximate });
		state.timer = setTimeout(() => {
			state.timer = undefined;
			void activeRenderer
				.render({
					kind,
					entryFile: document.uri.fsPath,
					text: document.getText(),
					width: NATIVE_RENDER_WIDTH,
					height: NATIVE_RENDER_HEIGHT,
				})
				.then((output) => {
					if (renderStates.get(panel) !== state || state.token !== token) {
						fs.rmSync(output.pngPath, { force: true });
						return;
					}
					postRenderState(panel, {
						state: "ready",
						approximate,
						engine: output.engine,
						ms: Math.round(output.ms),
						width: output.width,
						height: output.height,
						imageUri: panel.webview.asWebviewUri(vscode.Uri.file(output.pngPath)).toString(),
					});
				})
				.catch((error: unknown) => {
					if (renderStates.get(panel) !== state || state.token !== token) return;
					postRenderState(panel, { state: "failed", approximate, message: describeRenderError(error) });
				});
		}, delayMs);
	};
	const queueModelUpdate = (document: vscode.TextDocument): void => {
		const key = document.uri.toString();
		const pending = pendingUpdates.get(key);
		if (pending !== undefined) {
			pending.document = document;
			return;
		}
		const timer = setTimeout(() => {
			const latest = pendingUpdates.get(key);
			pendingUpdates.delete(key);
			if (!latest) return;
			const documentPanels = panels.get(key);
			if (!documentPanels) return;
			Array.from(documentPanels, (panel) => {
				sendModel(latest.document, panel);
				requestRender(latest.document, panel, NATIVE_RENDER_DEBOUNCE_MS);
			});
		}, PREVIEW_UPDATE_DELAY_MS);
		pendingUpdates.set(key, { document, timer });
	};
	const onMessage = async (
		document: vscode.TextDocument,
		panel: vscode.WebviewPanel,
		message: PreviewMessage,
	): Promise<void> => {
		if (message.command === "openGodot") {
			await vscode.commands.executeCommand("neoGodotTools.openEditor");
			return;
		}
		if (message.command === "ready") {
			readyPanels.add(panel);
			sendModel(document, panel);
			requestRender(document, panel, 0);
			return;
		}
		if (message.command !== "openSource" || !Number.isInteger(message.position)) return;
		const position = Math.max(0, Math.min(message.position ?? 0, document.getText().length));
		const editor = await vscode.window.showTextDocument(document, { preview: true });
		const start = document.positionAt(position);
		editor.selection = new vscode.Selection(start, start);
		editor.revealRange(new vscode.Range(start, start));
	};
	const provider: vscode.CustomTextEditorProvider = {
		resolveCustomTextEditor: async (document, panel) => {
			const key = document.uri.toString();
			const documentPanels = panels.get(key) ?? new Set<vscode.WebviewPanel>();
			documentPanels.add(panel);
			panels.set(key, documentPanels);
			panel.webview.options = { enableScripts: true, localResourceRoots: previewRoots(document.uri) };
			panel.webview.html = html(panel.webview);
			panel.webview.onDidReceiveMessage((message: unknown) => {
				if (isPreviewMessage(message)) void onMessage(document, panel, message);
			});
			panel.onDidDispose(() => {
				readyPanels.delete(panel);
				const renderState = renderStates.get(panel);
				if (renderState?.timer !== undefined) clearTimeout(renderState.timer);
				renderStates.delete(panel);
				documentPanels.delete(panel);
				if (documentPanels.size === 0) {
					panels.delete(key);
					const pending = pendingUpdates.get(key);
					if (pending !== undefined) {
						clearTimeout(pending.timer);
						pendingUpdates.delete(key);
					}
				}
			});
		},
	};
	context.subscriptions.push(
		vscode.window.registerCustomEditorProvider(SCENE_2D_PREVIEW_VIEW_TYPE, provider, {
			webviewOptions: { retainContextWhenHidden: true },
			supportsMultipleEditorsPerDocument: true,
		}),
		vscode.window.registerCustomEditorProvider(SHADER_PREVIEW_VIEW_TYPE, provider, {
			webviewOptions: { retainContextWhenHidden: true },
			supportsMultipleEditorsPerDocument: true,
		}),
		vscode.workspace.onDidChangeTextDocument((event) => {
			if (!isPreviewDocument(event.document)) return;
			if (previewKind(event.document.uri) === "scene") sceneCache.delete(event.document.uri.toString());
			if (previewKind(event.document.uri) === "shader") shaderCache.delete(event.document.uri.toString());
			queueModelUpdate(event.document);
		}),
		vscode.workspace.onDidCloseTextDocument((document) => {
			const key = document.uri.toString();
			const pending = pendingUpdates.get(key);
			if (pending !== undefined) clearTimeout(pending.timer);
			pendingUpdates.delete(key);
			sceneCache.delete(document.uri.toString());
			shaderCache.delete(document.uri.toString());
		}),
		vscode.workspace.onDidSaveTextDocument((document) => {
			if (!isPreviewDocument(document)) return;
			const documentPanels = panels.get(document.uri.toString());
			if (!documentPanels) return;
			Array.from(documentPanels, (panel) => {
				if (readyPanels.has(panel)) requestRender(document, panel, 0);
			});
		}),
	);
	return provider;
}

export function buildScenePreviewModel(scene: Scene, webview?: vscode.Webview): ScenePreviewModel {
	const warnings: string[] = [];
	const root = scene.root;
	const resources = createScenePreviewResources(scene, webview);
	const nodes = root ? [buildPreviewNode(root, scene, warnings, resources)] : [];
	return { kind: "scene", uri: vscode.Uri.file(scene.path).toString(), title: scene.title, nodes, warnings };
}

export function buildShaderPreviewModel(source: string, uri: vscode.Uri): ShaderPreviewModel {
	const analysis = analyzeShaderSource(source);
	const uniforms = parseShaderUniforms(analysis.cleanSource, "shader_parameter/", true).map((uniform) => ({
		name: uniform.name.replace(/^shader_parameter\//, "").replace(/^shader_param\//, ""),
		type: uniform.type,
		defaultValue: uniform.defaultValue,
		hint: uniform.hint,
		hintString: uniform.hintString,
	}));
	const warnings =
		analysis.shaderType === "canvas_item"
			? []
			: [`Static preview is limited to canvas_item shaders; shader_type is ${analysis.shaderType}.`];
	warnings.push("The browser preview does not execute Godot shader code; it shows shader metadata only.");
	const renderModes = analysis.renderModes;
	const functions = analysis.functions;
	const diagnostics = analysis.diagnostics;
	return {
		kind: "shader",
		uri: uri.toString(),
		shaderType: analysis.shaderType,
		renderModes,
		uniforms,
		functions,
		lineCount: analysis.lineCount,
		diagnostics,
		warnings,
	};
}

function buildPreviewNode(
	node: SceneNode,
	scene: Scene,
	warnings: string[],
	resources?: ScenePreviewResources,
): PreviewNode {
	const values = new Map(node.properties.map((property) => [property.name, parseVariant(property.raw).value]));
	const position = vector(values.get("position"));
	const scale = vector(values.get("scale"), [1, 1]) ?? [1, 1];
	const size = vector(values.get("size")) ?? [
		values.has("offset_right")
			? number(values.get("offset_right")) - number(values.get("offset_left"))
			: defaultWidth(node.className),
		values.has("offset_bottom")
			? number(values.get("offset_bottom")) - number(values.get("offset_top"))
			: defaultHeight(node.className),
	];
	const width = Math.max(1, Math.abs(size?.[0] ?? defaultWidth(node.className)));
	const height = Math.max(1, Math.abs(size?.[1] ?? defaultHeight(node.className)));
	const texture = values.get("texture");
	const texturePath =
		texture?.kind === "ExtResource" ? scene.externalResources.get(texture.referenceId ?? "")?.path : undefined;
	if (node.className.includes("3D") || node.className === "Node3D")
		warnings.push(`${node.path || node.label}: 3D nodes are shown as placeholders.`);
	return {
		path: node.path,
		className: node.className,
		label: node.label,
		position: node.position,
		x: position?.[0] ?? number(values.get("offset_left")),
		y: position?.[1] ?? number(values.get("offset_top")),
		width,
		height,
		rotation: number(values.get("rotation")) * (180 / Math.PI),
		scaleX: scale[0],
		scaleY: scale[1],
		color: color(values.get("color"), node.className),
		text: text(values.get("text")),
		texturePath,
		textureUri: texturePath ? resources?.textureUri(texturePath) : undefined,
		properties: node.properties.map((property) => ({ name: property.name, value: property.raw })),
		children: node.children.map((child) => buildPreviewNode(child, scene, warnings, resources)),
	};
}

function vector(value: VariantValue | undefined, fallback?: [number, number]): [number, number] | undefined {
	if (value?.components && value.components.length >= 2) return [value.components[0], value.components[1]];
	return fallback;
}

function number(value: VariantValue | undefined): number {
	return value?.number !== undefined && Number.isFinite(value.number) ? value.number : 0;
}

function text(value: VariantValue | undefined): string | undefined {
	return value?.text;
}

function color(value: VariantValue | undefined, className: string): string {
	if (value?.components && value.components.length >= 3) {
		const [r, g, b, a = 1] = value.components.map((component) => Math.max(0, Math.min(1, component)));
		return `rgba(${Math.round(r * 255)},${Math.round(g * 255)},${Math.round(b * 255)},${a})`;
	}
	if (className === "ColorRect") return "rgba(85, 140, 220, 0.65)";
	if (className.includes("Collision")) return "rgba(240, 160, 60, 0.35)";
	return "rgba(110, 125, 150, 0.28)";
}

function defaultWidth(className: string): number {
	if (className === "Label" || className === "Button") return 120;
	if (className.includes("Collision")) return 48;
	return 64;
}

function defaultHeight(className: string): number {
	if (className === "Label" || className === "Button") return 28;
	if (className.includes("Collision")) return 48;
	return 64;
}

function findProjectRoot(uri: vscode.Uri): vscode.Uri | undefined {
	if (uri.scheme !== "file") return vscode.workspace.getWorkspaceFolder(uri)?.uri;
	const findProject = (current: string, depth: number): vscode.Uri | undefined => {
		if (fs.existsSync(path.join(current, "project.godot"))) return vscode.Uri.file(current);
		const parent = path.dirname(current);
		if (parent === current || depth === 32) return undefined;
		return findProject(parent, depth + 1);
	};
	const project = findProject(path.dirname(uri.fsPath), 0);
	if (project) return project;
	return vscode.workspace.getWorkspaceFolder(uri)?.uri;
}

function createScenePreviewResources(
	scene: Scene,
	webview: vscode.Webview | undefined,
): ScenePreviewResources | undefined {
	if (!webview?.asWebviewUri) return undefined;
	const roots = [
		findProjectRoot(vscode.Uri.file(scene.path)),
		...(vscode.workspace.workspaceFolders?.map((folder) => folder.uri) ?? []),
		vscode.Uri.file(path.dirname(scene.path)),
	].filter((root): root is vscode.Uri => Boolean(root));
	const resolved = new Map<string, string | undefined>();
	return {
		textureUri: (imagePath: string): string | undefined => {
			if (resolved.has(imagePath)) return resolved.get(imagePath);
			const uri = /\.(?:png|svg|jpe?g|webp|gif|bmp|ico|avif)$/i.test(imagePath)
				? (() => {
						const target = resolveSceneResourcePath(scene.path, imagePath);
						if (!target || !fs.existsSync(target)) return undefined;
						const targetUri = vscode.Uri.file(target);
						return insideRoots(targetUri, roots) ? webview.asWebviewUri(targetUri).toString() : undefined;
					})()
				: undefined;
			resolved.set(imagePath, uri);
			return uri;
		},
	};
}

function resolveSceneResourcePath(scenePath: string, resourcePath: string): string | undefined {
	const normalized = resourcePath.replace(/\\/g, "/");
	if (normalized.startsWith("res://")) {
		const project = findProjectRoot(vscode.Uri.file(scenePath));
		return project ? path.resolve(project.fsPath, normalized.slice("res://".length)) : undefined;
	}
	if (/^[A-Za-z][A-Za-z0-9+.-]*:/.test(normalized)) return undefined;
	return path.resolve(path.dirname(scenePath), normalized);
}

function insideRoots(file: vscode.Uri, roots: vscode.Uri[]): boolean {
	try {
		const filePath = fs.realpathSync(file.fsPath);
		return roots.some((root) => {
			try {
				const relative = path.relative(fs.realpathSync(root.fsPath), filePath);
				return relative !== ".." && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative);
			} catch {
				return false;
			}
		});
	} catch {
		return false;
	}
}

function createPreviewRenderer(context: vscode.ExtensionContext): GodotRenderer | undefined {
	try {
		const renderer = createGodotRenderer(context.extensionUri, context.globalStorageUri);
		context.subscriptions.push({ dispose: () => renderer.dispose() });
		return renderer;
	} catch (error) {
		console.warn("[neo-godot-tools] native Godot previews are unavailable", error);
		return undefined;
	}
}

function createNonce(): string {
	return Array.from({ length: 24 }, () => Math.floor(Math.random() * 36).toString(36)).join("");
}

export const STATIC_PREVIEW_CSS = `:root{color-scheme:light dark;font-family:var(--vscode-font-family,sans-serif);color:var(--vscode-foreground);background:var(--vscode-editor-background)}*{box-sizing:border-box}body{margin:0;height:100vh;display:flex;flex-direction:column;overflow:hidden}header{min-height:48px;display:flex;align-items:center;flex-wrap:wrap;gap:8px 14px;padding:8px 16px;border-bottom:1px solid var(--vscode-panel-border)}header>span,#zoomLabel{color:var(--vscode-descriptionForeground);font-size:12px}nav{display:flex;align-items:center;flex-wrap:wrap;gap:4px;margin-left:auto}button{border:1px solid transparent;border-radius:4px;padding:5px 9px;background:var(--vscode-button-secondaryBackground);color:var(--vscode-button-secondaryForeground);cursor:pointer}button:hover{background:var(--vscode-button-secondaryHoverBackground)}button:focus-visible{outline:1px solid var(--vscode-focusBorder)}#zoomLabel{min-width:42px;text-align:center}main{min-height:0;flex:1;display:grid;grid-template-columns:minmax(0,1fr) minmax(220px,280px)}#canvas{min-width:0;min-height:0;overflow:auto;padding:40px;height:100%;background-color:var(--vscode-editor-background);background-image:linear-gradient(var(--vscode-panel-border,transparent) 1px,transparent 1px),linear-gradient(90deg,var(--vscode-panel-border,transparent) 1px,transparent 1px);background-size:24px 24px;position:relative;outline:none}#canvas:focus{box-shadow:inset 0 0 0 1px var(--vscode-focusBorder)}svg{display:block;overflow:visible;transform-origin:top left}aside{border-left:1px solid var(--vscode-panel-border);padding:18px;overflow:auto;font-size:12px;overflow-wrap:anywhere}aside h3{margin:0 0 10px;font-size:13px}aside h4{margin:18px 0 8px}aside button{display:block;width:100%;text-align:left;margin:8px 0}.warning{padding:9px;margin:10px 0;border-left:2px solid var(--vscode-editorWarning-foreground);color:var(--vscode-editorWarning-foreground);overflow-wrap:anywhere}.empty{padding:12px 0;color:var(--vscode-descriptionForeground)}.selected{outline:2px solid var(--vscode-focusBorder)}.uniform{padding:10px 0;border-bottom:1px solid var(--vscode-panel-border);overflow-wrap:anywhere}.uniform small{display:block;margin-top:4px;color:var(--vscode-descriptionForeground)}.status,.shader-sheet{max-width:640px;margin:auto;padding:28px;border:1px solid var(--vscode-panel-border);border-radius:6px;background:var(--vscode-editor-background);overflow-wrap:anywhere}.status h2,.shader-sheet h2{margin:0 0 12px;font-size:18px}.status p,.shader-sheet p{line-height:1.6;color:var(--vscode-descriptionForeground)}.capability{border-left:2px solid var(--vscode-focusBorder);padding-left:12px}.facts{display:flex;flex-wrap:wrap;gap:10px;margin-top:24px}.fact{padding:10px 14px;border:1px solid var(--vscode-panel-border);border-radius:4px}@media(max-width:680px){header{align-items:flex-start}nav{margin-left:0;width:100%}main{display:flex;flex-direction:column;overflow:auto}#canvas{flex:0 0 auto;min-height:280px;height:auto;padding:20px}aside{overflow:visible;border-left:0;border-top:1px solid var(--vscode-panel-border)}}`;

export const STATIC_PREVIEW_SCRIPT = [
	"(() => {const vscode=acquireVsCodeApi();",
	"const canvas=document.getElementById('canvas');const details=document.getElementById('details');const titleElement=document.getElementById('title');const meta=document.getElementById('meta');const zoomLabel=document.getElementById('zoomLabel');let model;let zoom=1;let selectedPath='';let nativeImage;let autoFit=true;let renderState='static';let renderDetail='';let renderDirty=false;",
	"function appendText(parent,tag,value,style){const element=document.createElement(tag);element.textContent=value;if(style)element.className=style;parent.append(element);return element}function showStatus(heading,message){canvas.replaceChildren();const section=document.createElement('section');section.className='status';section.setAttribute('role','status');appendText(section,'h2',heading);appendText(section,'p',message);canvas.append(section)}function showDetails(node){details.replaceChildren();if(!node){appendText(details,'div','Select a node to inspect its source properties. This is an approximate static diagram; scripts and layout are not evaluated.','empty');return}selectedPath=node.path;appendText(details,'h3',node.label);appendText(details,'div',node.className+' · '+(node.path||'.'));if(node.properties?.length){appendText(details,'h4','Overrides');node.properties.forEach((property)=>appendText(details,'div',property.name+' = '+property.value))}const button=appendText(details,'button','Open source');button.onclick=()=>vscode.postMessage({command:'openSource',position:node.position})}",
	"function nodeElement(node){const group=document.createElementNS('http://www.w3.org/2000/svg','g');group.setAttribute('transform','translate('+node.x+' '+node.y+') rotate('+node.rotation+') scale('+node.scaleX+' '+node.scaleY+')');group.dataset.path=node.path;const rect=document.createElementNS('http://www.w3.org/2000/svg','rect');rect.setAttribute('width',node.width);rect.setAttribute('height',node.height);rect.setAttribute('rx','3');rect.setAttribute('fill',node.color);rect.setAttribute('stroke','rgba(220,230,240,.7)');rect.setAttribute('stroke-width','1');group.append(rect);if(node.textureUri){const image=document.createElementNS('http://www.w3.org/2000/svg','image');image.setAttribute('href',node.textureUri);image.setAttribute('x','0');image.setAttribute('y','0');image.setAttribute('width',node.width);image.setAttribute('height',node.height);image.setAttribute('preserveAspectRatio','xMidYMid slice');group.append(image)}const label=document.createElementNS('http://www.w3.org/2000/svg','text');label.textContent=node.text||node.label;label.setAttribute('x','6');label.setAttribute('y','18');label.setAttribute('fill','var(--vscode-foreground)');label.setAttribute('font-size','12');group.append(label);group.onclick=(event)=>{event.stopPropagation();document.querySelectorAll('g[data-path]').forEach((item)=>item.classList.remove('selected'));group.classList.add('selected');showDetails(node)};node.children.forEach((child)=>group.append(nodeElement(child)));return group}",
	"function transformPoint(point,transform){return{x:transform.a*point.x+transform.c*point.y+transform.e,y:transform.b*point.x+transform.d*point.y+transform.f}}",
	"function multiply(left,right){return{a:left.a*right.a+left.c*right.b,b:left.b*right.a+left.d*right.b,c:left.a*right.c+left.c*right.d,d:left.b*right.c+left.d*right.d,e:left.a*right.e+left.c*right.f+left.e,f:left.b*right.e+left.d*right.f+left.f}}",
	"function localTransform(node){const angle=node.rotation*Math.PI/180;const cos=Math.cos(angle),sin=Math.sin(angle);return{a:cos*node.scaleX,b:sin*node.scaleX,c:-sin*node.scaleY,d:cos*node.scaleY,e:node.x,f:node.y}}",
	"function includePoint(point,result){result.minX=Math.min(result.minX,point.x);result.minY=Math.min(result.minY,point.y);result.maxX=Math.max(result.maxX,point.x);result.maxY=Math.max(result.maxY,point.y)}",
	"function sceneBounds(nodes,parentTransform,result){nodes.forEach((node)=>{const transform=multiply(parentTransform,localTransform(node));includePoint(transformPoint({x:0,y:0},transform),result);includePoint(transformPoint({x:node.width,y:0},transform),result);includePoint(transformPoint({x:0,y:node.height},transform),result);includePoint(transformPoint({x:node.width,y:node.height},transform),result);sceneBounds(node.children,transform,result)})}",
	"function renderScene(){canvas.replaceChildren();if(model.error||!model.nodes.length){showStatus(model.error?'Unable to read scene':'No scene nodes found',model.error||'Add a node in the scene source, or open the project in Godot.');showDetails(undefined);return}const svg=document.createElementNS('http://www.w3.org/2000/svg','svg');const bounds={minX:Infinity,minY:Infinity,maxX:-Infinity,maxY:-Infinity};const identity={a:1,b:0,c:0,d:1,e:0,f:0};sceneBounds(model.nodes,identity,bounds);const padding=40;const x=bounds.minX-padding;const y=bounds.minY-padding;const width=Math.max(1,bounds.maxX-bounds.minX+padding*2);const height=Math.max(1,bounds.maxY-bounds.minY+padding*2);svg.setAttribute('viewBox',x+' '+y+' '+width+' '+height);svg.setAttribute('width',String(Math.max(1,width*zoom)));svg.setAttribute('height',String(Math.max(1,height*zoom)));svg.onclick=()=>showDetails(undefined);model.nodes.forEach((node)=>svg.append(nodeElement(node)));canvas.append(svg);if(selectedPath)document.querySelectorAll('g[data-path]').forEach((item)=>{if(item.dataset.path===selectedPath)item.classList.add('selected')});showDetails(undefined);model.warnings.forEach((warning)=>appendText(details,'div',warning,'warning'));zoomLabel.textContent=Math.round(zoom*100)+'%'}",
	"function addUniformControl(uniform){const row=appendText(details,'div',uniform.name+' = '+(uniform.defaultValue||'(no default)'),'uniform');appendText(row,'small',uniform.type+(uniform.hintString?' · '+uniform.hintString:''))}",
	"function renderNative(){canvas.replaceChildren();const figure=document.createElement('figure');figure.className='native-frame';const image=document.createElement('img');image.className='native-render';image.src=nativeImage.uri;image.alt=(model.kind==='scene'?model.title:'Shader preview')+' rendered by Godot';image.style.width=Math.round(nativeImage.width*zoom)+'px';image.style.height='auto';figure.append(image);zoomLabel.textContent=Math.round(zoom*100)+'%';const caption=document.createElement('figcaption');caption.textContent=(nativeImage.engine==='4'?'Godot 4':'Godot 3')+' render · '+nativeImage.width+' × '+nativeImage.height+(nativeImage.ms?' · '+nativeImage.ms+' ms':'');figure.append(caption);canvas.append(figure);details.replaceChildren();appendText(details,'h3',model.kind==='scene'?'Godot render':'Shader output');appendText(details,'div',model.kind==='scene'?'The native render shows the scene as Godot composes it. Switch to the static sketch to select nodes and read source properties.':'Rendered on a checkerboard by the configured Godot executable.','empty');if(model.kind==='shader'){appendText(details,'h4','Uniform defaults');if(!model.uniforms.length)appendText(details,'div','No uniforms declared.','empty');model.uniforms.forEach(addUniformControl);model.diagnostics.forEach((diagnostic)=>appendText(details,'div','Line '+diagnostic.line+': '+diagnostic.message,'warning'))}model.warnings.filter((warning)=>!/does not execute|not executed/.test(warning)).forEach((warning)=>appendText(details,'div',warning,'warning'))}",
	"function fitNative(){const availableWidth=Math.max(1,canvas.clientWidth-80);const availableHeight=Math.max(1,canvas.clientHeight-80);zoom=Math.max(.25,Math.min(4,Math.min(availableWidth/nativeImage.width,availableHeight/nativeImage.height)));render()}",
	"function updateRenderState(){const base=model.kind==='scene'?model.nodes.length+' root node(s)':model.shaderType;if(renderState==='rendering'){meta.textContent=base+' · '+(renderDirty?'updating unsaved':'rendering in Godot');meta.title='Building a native render with the configured Godot executable.';meta.dataset.state='busy'}else if(renderState==='ready'){meta.textContent=base+' · '+(renderDirty?'live render · unsaved':'Godot render')+(nativeImage.ms?' · '+nativeImage.ms+' ms':'');meta.title='Rendered by the configured Godot executable.';meta.dataset.state='ready'}else if(renderState==='failed'){meta.textContent=base+' · Godot render failed';meta.title=renderDetail||'Godot could not render this file.';meta.dataset.state='failed'}else if(renderState==='unavailable'){meta.textContent=base+' · static preview';meta.title=renderDetail;meta.dataset.state='static'}else{meta.textContent=base+' · static preview';meta.title='Approximate sketch built from scene text. Project scripts are not executed.';meta.dataset.state='static'}}",
	"function applyRenderState(data){renderDirty=Boolean(data.approximate);renderDetail=data.message||'';if(data.state==='ready'&&data.imageUri){nativeImage={uri:data.imageUri,width:Math.max(1,data.width||1),height:Math.max(1,data.height||1),engine:data.engine,ms:data.ms};renderState='ready';if(autoFit)fitNative();else render()}else if(data.state==='rendering'){renderState='rendering';if(nativeImage)updateRenderState();else render()}else{nativeImage=undefined;renderState=data.state==='failed'?'failed':'unavailable';render()}}",
	"function renderShader(){canvas.replaceChildren();const sheet=document.createElement('section');sheet.className='shader-sheet';appendText(sheet,'p','STATIC INTERFACE STUDY');appendText(sheet,'h2',model.shaderType+' shader');appendText(sheet,'p','Godot shader code is not executed here. This sheet describes declarations, not rendered material output.','capability');const facts=appendText(sheet,'div','','facts');appendText(facts,'div',model.uniforms.length+' uniforms','fact');appendText(facts,'div',model.functions.length+' functions','fact');appendText(facts,'div',model.lineCount+' lines','fact');appendText(sheet,'p','Functions: '+(model.functions.join(', ')||'none'));appendText(sheet,'p','Render modes: '+(model.renderModes.join(', ')||'default'));canvas.append(sheet);details.replaceChildren();appendText(details,'h3','Uniform defaults');if(!model.uniforms.length)appendText(details,'div','No uniforms declared.','empty');model.uniforms.forEach(addUniformControl);model.diagnostics.forEach((diagnostic)=>appendText(details,'div','Line '+diagnostic.line+': '+diagnostic.message,'warning'));model.warnings.forEach((warning)=>appendText(details,'div',warning,'warning'))}",
	"function render(){if(!model)return;titleElement.textContent=model.kind==='scene'?model.title:'Shader preview';if(nativeImage){renderNative()}else if(model.kind==='scene')renderScene();else renderShader();updateRenderState()}function fitScene(){if(nativeImage){fitNative();return}const svg=canvas.querySelector('svg');if(!svg)return;const box=svg.viewBox.baseVal;const availableWidth=Math.max(1,canvas.clientWidth-80);const availableHeight=Math.max(1,canvas.clientHeight-80);zoom=Math.max(.25,Math.min(4,Math.min(availableWidth/box.width,availableHeight/box.height)));render()}document.getElementById('zoomIn').onclick=()=>{autoFit=false;zoom=Math.min(4,zoom*1.25);render()};document.getElementById('zoomOut').onclick=()=>{autoFit=false;zoom=Math.max(.25,zoom/1.25);render()};document.getElementById('fit').onclick=()=>{autoFit=true;fitScene()};document.getElementById('openSource').onclick=()=>vscode.postMessage({command:'openSource',position:0});document.getElementById('openGodot').onclick=()=>vscode.postMessage({command:'openGodot'});canvas.onkeydown=(event)=>{if(event.key==='+'||event.key==='='){autoFit=false;zoom=Math.min(4,zoom*1.25);render()}if(event.key==='-'){autoFit=false;zoom=Math.max(.25,zoom/1.25);render()}};window.addEventListener('error',(event)=>showStatus('Preview error',event.message||'Unable to display this preview.'));window.addEventListener('message',(event)=>{const data=event.data;if(!data)return;if(data.type==='model'){model=data.model;selectedPath='';renderDirty=Boolean(data.dirty);render();if(autoFit&&model.kind==='scene'&&model.nodes.length)fitScene()}else if(data.type==='render'){applyRenderState(data)}});vscode.postMessage({command:'ready'});})();",
].join("");
