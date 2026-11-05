import * as fs from "node:fs";
import * as path from "node:path";
import * as vscode from "vscode";
import { parseShaderUniforms } from "../resource_inspector/metadata.js";
import { parseVariant, type VariantValue } from "../resource_inspector/values.js";
import { SceneParser } from "../scene_tools/parser.js";
import { Scene, SceneNode } from "../scene_tools/types.js";

export const SCENE_2D_PREVIEW_VIEW_TYPE = "neoGodotTools.scene2dPreview";
export const SHADER_PREVIEW_VIEW_TYPE = "neoGodotTools.shaderPreview";

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
	children: PreviewNode[];
}

interface ScenePreviewModel {
	kind: "scene";
	uri: string;
	title: string;
	nodes: PreviewNode[];
	warnings: string[];
}

interface ShaderPreviewModel {
	kind: "shader";
	uri: string;
	shaderType: string;
	uniforms: Array<{ name: string; type: string; defaultValue?: string }>;
	warnings: string[];
}

interface PreviewMessage {
	command?: string;
	position?: number;
}

type PreviewModel = ScenePreviewModel | ShaderPreviewModel;

export class StaticPreviewProvider implements vscode.CustomTextEditorProvider {
	private readonly panels = new Map<string, Set<vscode.WebviewPanel>>();
	private readonly parser = new SceneParser();

	constructor(context: vscode.ExtensionContext) {
		context.subscriptions.push(
			vscode.window.registerCustomEditorProvider(SCENE_2D_PREVIEW_VIEW_TYPE, this, {
				webviewOptions: { retainContextWhenHidden: true },
				supportsMultipleEditorsPerDocument: true,
			}),
			vscode.window.registerCustomEditorProvider(SHADER_PREVIEW_VIEW_TYPE, this, {
				webviewOptions: { retainContextWhenHidden: true },
				supportsMultipleEditorsPerDocument: true,
			}),
			vscode.workspace.onDidChangeTextDocument((event) => {
				const panels = this.panels.get(event.document.uri.toString());
				if (!panels || !this.isPreviewDocument(event.document)) return;
				for (const panel of panels) void this.sendModel(event.document, panel);
			}),
		);
	}

	async resolveCustomTextEditor(document: vscode.TextDocument, panel: vscode.WebviewPanel): Promise<void> {
		const key = document.uri.toString();
		const panels = this.panels.get(key) ?? new Set<vscode.WebviewPanel>();
		panels.add(panel);
		this.panels.set(key, panels);
		panel.webview.options = { enableScripts: true, localResourceRoots: this.previewRoots(document.uri) };
		panel.webview.html = this.html(panel.webview);
		panel.webview.onDidReceiveMessage((message: PreviewMessage) => void this.onMessage(document, message));
		panel.onDidDispose(() => {
			panels.delete(panel);
			if (!panels.size) this.panels.delete(key);
		});
		await this.sendModel(document, panel);
	}

	private async onMessage(document: vscode.TextDocument, message: PreviewMessage): Promise<void> {
		if (message.command !== "openSource" || !Number.isInteger(message.position)) return;
		const position = Math.max(0, Math.min(message.position ?? 0, document.getText().length));
		const editor = await vscode.window.showTextDocument(document, { preview: true });
		const start = document.positionAt(position);
		editor.selection = new vscode.Selection(start, start);
		editor.revealRange(new vscode.Range(start, start));
	}

	private async sendModel(document: vscode.TextDocument, panel: vscode.WebviewPanel): Promise<void> {
		const model = this.buildModel(document, panel.webview);
		if (!model) return;
		panel.webview.options = { ...panel.webview.options, localResourceRoots: this.previewRoots(document.uri) };
		void panel.webview.postMessage({ type: "model", model });
	}

	private buildModel(document: vscode.TextDocument, webview?: vscode.Webview): PreviewModel | undefined {
		if (document.uri.path.toLowerCase().endsWith(".gdshader")) return buildShaderPreviewModel(document.getText(), document.uri);
		if (!document.uri.path.toLowerCase().endsWith(".tscn")) return undefined;
		try {
			const scene = this.parser.parse_scene(document);
			return buildScenePreviewModel(scene, webview);
		} catch (error: unknown) {
			return {
				kind: "scene",
				uri: document.uri.toString(),
				title: path.basename(document.uri.fsPath || document.uri.path),
				nodes: [],
				warnings: [`Unable to parse scene: ${String(error)}`],
			};
		}
	}

	private isPreviewDocument(document: vscode.TextDocument): boolean {
		const lower = document.uri.path.toLowerCase();
		return lower.endsWith(".tscn") || lower.endsWith(".gdshader");
	}

	private previewRoots(documentUri: vscode.Uri): vscode.Uri[] {
		const roots = vscode.workspace.workspaceFolders?.map((folder) => folder.uri) ?? [];
		const project = findProjectRoot(documentUri);
		if (project && !roots.some((root) => root.toString() === project.toString())) roots.push(project);
		return roots;
	}

	private html(webview: vscode.Webview): string {
		const nonce = createNonce();
		return `<!doctype html><html><head><meta charset="UTF-8"><meta http-equiv="Content-Security-Policy" content="default-src 'none'; img-src ${webview.cspSource} https: data:; style-src ${webview.cspSource} 'unsafe-inline'; script-src 'nonce-${nonce}';"><style>${STATIC_PREVIEW_CSS}</style></head><body><header><strong id="title">Preview</strong><span id="meta"></span></header><main><div id="canvas" aria-label="Static preview"></div><aside id="details"></aside></main><script nonce="${nonce}">${STATIC_PREVIEW_SCRIPT}</script></body></html>`;
	}
}

export function buildScenePreviewModel(scene: Scene, webview?: vscode.Webview): ScenePreviewModel {
	const warnings: string[] = [];
	const root = scene.root;
	const nodes = root ? [buildPreviewNode(root, scene, warnings, webview)] : [];
	return { kind: "scene", uri: vscode.Uri.file(scene.path).toString(), title: scene.title, nodes, warnings };
}

export function buildShaderPreviewModel(source: string, uri: vscode.Uri): ShaderPreviewModel {
	const shaderType = source.match(/\bshader_type\s+([A-Za-z_][A-Za-z0-9_]*)/)?.[1] ?? "canvas_item";
	const uniforms = parseShaderUniforms(source).map((uniform) => ({
		name: uniform.name.replace(/^shader_parameter\//, "").replace(/^shader_param\//, ""),
		type: uniform.type,
		defaultValue: uniform.defaultValue,
	}));
	const warnings = shaderType === "canvas_item" ? [] : [`Static preview is limited to canvas_item shaders; shader_type is ${shaderType}.`];
	warnings.push("The browser preview does not execute Godot shader code; it shows shader metadata only.");
	return { kind: "shader", uri: uri.toString(), shaderType, uniforms, warnings };
}

function buildPreviewNode(node: SceneNode, scene: Scene, warnings: string[], webview?: vscode.Webview): PreviewNode {
	const values = new Map(node.properties.map((property) => [property.name, parseVariant(property.raw).value]));
	const position = vector(values.get("position"));
	const scale = vector(values.get("scale"), [1, 1]) ?? [1, 1];
	const size = vector(values.get("size")) ?? [
		number(values.get("offset_right")),
		number(values.get("offset_bottom")),
	];
	const width = Math.max(1, Math.abs(size?.[0] ?? defaultWidth(node.className)));
	const height = Math.max(1, Math.abs(size?.[1] ?? defaultHeight(node.className)));
	const texture = values.get("texture");
	const texturePath = texture?.kind === "ExtResource"
		? scene.externalResources.get(texture.referenceId ?? "")?.path
		: undefined;
	if (node.className.includes("3D") || node.className === "Node3D") warnings.push(`${node.path || node.label}: 3D nodes are shown as placeholders.`);
	return {
		path: node.path,
		className: node.className,
		label: node.label,
		position: node.position,
		x: position?.[0] ?? 0,
		y: position?.[1] ?? 0,
		width,
		height,
		rotation: number(values.get("rotation")) * (180 / Math.PI),
		scaleX: scale[0],
		scaleY: scale[1],
		color: color(values.get("color"), node.className),
		text: text(values.get("text")),
		texturePath,
		textureUri: texturePath ? imageUriForScene(scene, texturePath, webview) : undefined,
		children: node.children.map((child) => buildPreviewNode(child, scene, warnings, webview)),
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
	let current = path.dirname(uri.fsPath);
	for (let depth = 0; depth < 32; depth++) {
		if (fs.existsSync(path.join(current, "project.godot"))) return vscode.Uri.file(current);
		const parent = path.dirname(current);
		if (parent === current) break;
		current = parent;
	}
	return vscode.workspace.getWorkspaceFolder(uri)?.uri;
}

function imageUriForScene(scene: Scene, imagePath: string, webview?: vscode.Webview): string | undefined {
	if (!webview?.asWebviewUri || !/\.(?:png|svg|jpe?g|webp|gif|bmp|ico|avif)$/i.test(imagePath)) return undefined;
	const target = resolveSceneResourcePath(scene.path, imagePath);
	if (!target || !fs.existsSync(target)) return undefined;
	const targetUri = vscode.Uri.file(target);
	const roots = [
		findProjectRoot(vscode.Uri.file(scene.path)),
		...(vscode.workspace.workspaceFolders?.map((folder) => folder.uri) ?? []),
		vscode.Uri.file(path.dirname(scene.path)),
	].filter((root): root is vscode.Uri => Boolean(root));
	if (!insideRoots(targetUri, roots)) return undefined;
	return webview.asWebviewUri(targetUri).toString();
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

function createNonce(): string {
	return Array.from({ length: 24 }, () => Math.floor(Math.random() * 36).toString(36)).join("");
}

const STATIC_PREVIEW_CSS = `:root{color-scheme:dark;font-family:var(--vscode-font-family);color:var(--vscode-foreground);background:var(--vscode-editor-background)}*{box-sizing:border-box}body{margin:0;height:100vh;display:flex;flex-direction:column;overflow:hidden}header{height:38px;display:flex;align-items:center;gap:12px;padding:0 12px;border-bottom:1px solid var(--vscode-panel-border)}header span{color:var(--vscode-descriptionForeground);font-size:12px}main{min-height:0;flex:1;display:grid;grid-template-columns:minmax(0,1fr) 240px}#canvas{min-width:0;min-height:0;overflow:auto;padding:40px;height:100%;background-color:#20242b;background-image:linear-gradient(#2b313a 1px,transparent 1px),linear-gradient(90deg,#2b313a 1px,transparent 1px);background-size:24px 24px;position:relative}svg{display:block;overflow:visible}aside{border-left:1px solid var(--vscode-panel-border);padding:12px;overflow:auto;font-size:12px}aside h3{margin:0 0 8px;font-size:13px}aside button{display:block;width:100%;text-align:left;margin:4px 0;padding:5px 7px;background:var(--vscode-button-secondaryBackground);border:0;color:var(--vscode-button-secondaryForeground);cursor:pointer}aside button:hover{background:var(--vscode-button-secondaryHoverBackground)}.warning{padding:8px;margin-bottom:8px;border:1px solid var(--vscode-editorWarning-foreground);color:var(--vscode-editorWarning-foreground)}.empty{padding:24px;color:var(--vscode-descriptionForeground)}.selected{outline:2px solid var(--vscode-focusBorder)}`;

const STATIC_PREVIEW_SCRIPT = [
	"const vscode=acquireVsCodeApi();",
	"const canvas=document.getElementById('canvas');const details=document.getElementById('details');const title=document.getElementById('title');const meta=document.getElementById('meta');let model;",
	"function showDetails(node){details.replaceChildren();if(!node){details.innerHTML='<div class=\"empty\">Select a node in the preview.</div>';return}const h=document.createElement('h3');h.textContent=node.label;details.append(h);const info=document.createElement('div');info.textContent=node.className+String.fromCharCode(10)+node.path;info.style.whiteSpace='pre-wrap';details.append(info);const button=document.createElement('button');button.textContent='Open source';button.onclick=()=>vscode.postMessage({command:'openSource',position:node.position});details.append(button)}",
	"function nodeElement(node){const group=document.createElementNS('http://www.w3.org/2000/svg','g');group.setAttribute('transform','translate('+node.x+' '+node.y+') rotate('+node.rotation+') scale('+node.scaleX+' '+node.scaleY+')');group.dataset.path=node.path;if(node.textureUri){const image=document.createElementNS('http://www.w3.org/2000/svg','image');image.setAttribute('href',node.textureUri);image.setAttribute('x','0');image.setAttribute('y','0');image.setAttribute('width',node.width);image.setAttribute('height',node.height);image.setAttribute('preserveAspectRatio','xMidYMid slice');group.append(image)}const rect=document.createElementNS('http://www.w3.org/2000/svg','rect');rect.setAttribute('width',node.width);rect.setAttribute('height',node.height);rect.setAttribute('rx','3');rect.setAttribute('fill',node.textureUri?'rgba(0,0,0,0)':node.color);rect.setAttribute('stroke','rgba(220,230,240,.7)');rect.setAttribute('stroke-width','1');group.append(rect);if(node.text){const label=document.createElementNS('http://www.w3.org/2000/svg','text');label.textContent=node.text;label.setAttribute('x','6');label.setAttribute('y','18');label.setAttribute('fill','white');label.setAttribute('font-size','12');group.append(label)}group.onclick=(event)=>{event.stopPropagation();document.querySelectorAll('g[data-path]').forEach((item)=>item.classList.remove('selected'));group.classList.add('selected');showDetails(node)};node.children.forEach((child)=>group.append(nodeElement(child)));return group}",
	"function transformPoint(point,transform){return{x:transform.a*point.x+transform.c*point.y+transform.e,y:transform.b*point.x+transform.d*point.y+transform.f}}",
	"function multiply(left,right){return{a:left.a*right.a+left.c*right.b,b:left.b*right.a+left.d*right.b,c:left.a*right.c+left.c*right.d,d:left.b*right.c+left.d*right.d,e:left.a*right.e+left.c*right.f+left.e,f:left.b*right.e+left.d*right.f+left.f}}",
	"function localTransform(node){const angle=node.rotation*Math.PI/180;const cos=Math.cos(angle),sin=Math.sin(angle);return{a:cos*node.scaleX,b:sin*node.scaleX,c:-sin*node.scaleY,d:cos*node.scaleY,e:node.x,f:node.y}}",
	"function includePoint(point,result){result.minX=Math.min(result.minX,point.x);result.minY=Math.min(result.minY,point.y);result.maxX=Math.max(result.maxX,point.x);result.maxY=Math.max(result.maxY,point.y)}",
	"function sceneBounds(nodes,parentTransform,result){nodes.forEach((node)=>{const transform=multiply(parentTransform,localTransform(node));[[0,0],[node.width,0],[0,node.height],[node.width,node.height]].forEach((corner)=>includePoint(transformPoint({x:corner[0],y:corner[1]},transform),result));sceneBounds(node.children,transform,result)})}",
	"function renderScene(){canvas.replaceChildren();const svg=document.createElementNS('http://www.w3.org/2000/svg','svg');const bounds={minX:0,minY:0,maxX:0,maxY:0};const identity={a:1,b:0,c:0,d:1,e:0,f:0};sceneBounds(model.nodes,identity,bounds);const padding=40;const x=bounds.minX-padding;const y=bounds.minY-padding;const width=Math.max(1,bounds.maxX-bounds.minX+padding*2);const height=Math.max(1,bounds.maxY-bounds.minY+padding*2);svg.setAttribute('viewBox',x+' '+y+' '+width+' '+height);svg.setAttribute('width','800');svg.setAttribute('height','600');svg.onclick=()=>showDetails(undefined);model.nodes.forEach((node)=>svg.append(nodeElement(node)));canvas.append(svg);details.replaceChildren();const warnings=model.warnings??[];warnings.forEach((warning)=>{const div=document.createElement('div');div.className='warning';div.textContent=warning;details.append(div)});if(!warnings.length)showDetails(undefined)}",
	"function renderShader(){canvas.replaceChildren();const card=document.createElement('div');card.className='empty';card.textContent='Static canvas_item shader metadata preview';canvas.append(card);details.replaceChildren();const h=document.createElement('h3');h.textContent='Shader uniforms';details.append(h);model.uniforms.forEach((uniform)=>{const row=document.createElement('div');row.textContent=uniform.name+' : '+uniform.type+(uniform.defaultValue?' = '+uniform.defaultValue:'');row.style.padding='5px 0';details.append(row)});(model.warnings??[]).forEach((warning)=>{const div=document.createElement('div');div.className='warning';div.textContent=warning;details.append(div)})}",
	"function render(){if(!model)return;title.textContent=model.kind==='scene'?model.title:'Shader preview';meta.textContent=model.kind==='scene'?model.nodes.length+' root node(s)':model.shaderType;if(model.kind==='scene')renderScene();else renderShader()}window.addEventListener('message',(event)=>{if(event.data?.type==='model'){model=event.data.model;render()}});vscode.postMessage({command:'ready'});",
].join("");
