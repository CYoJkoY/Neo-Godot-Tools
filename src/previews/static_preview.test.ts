import { strict as assert } from "node:assert";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { Script } from "node:vm";
import { describe, it } from "node:test";
import * as vscode from "vscode";
import { SceneParser } from "../scene_tools/parser.js";
import {
	buildScenePreviewModel,
	buildShaderPreviewModel,
	isPreviewMessage,
	nativeRenderSupport,
	STATIC_PREVIEW_CSS,
	STATIC_PREVIEW_SCRIPT,
} from "./static_preview.js";
import { analyzeShaderSource } from "./shader_analysis.js";

function makeDocument(uri: vscode.Uri, source: string): vscode.TextDocument {
	return {
		uri,
		languageId: uri.path.endsWith(".tscn") ? "gdscene" : "gdshader",
		version: 1,
		isDirty: false,
		lineCount: source.split(/\r?\n/).length,
		getText: () => source,
		lineAt: (line: number) => ({
			text: source.split(/\r?\n/)[line] ?? "",
			lineNumber: line,
			range: new vscode.Range(line, 0, line, (source.split(/\r?\n/)[line] ?? "").length),
		}),
		offsetAt: () => 0,
		positionAt: () => new vscode.Position(0, 0),
		getWordRangeAtPosition: () => undefined,
	} as unknown as vscode.TextDocument;
}

class MockElement {
	readonly children: MockElement[] = [];
	readonly dataset: Record<string, string> = {};
	readonly style: Record<string, string> = {};
	readonly attributes = new Map<string, string>();
	readonly classList = {
		values: new Set<string>(),
		add: (name: string): void => {
			this.classList.values.add(name);
		},
		remove: (name: string): void => {
			this.classList.values.delete(name);
		},
	};
	textContent = "";
	className = "";
	title = "";
	src = "";
	onclick: ((event: { stopPropagation(): void }) => void) | undefined;
	onkeydown: ((event: { key: string }) => void) | undefined;
	clientWidth = 800;
	clientHeight = 600;
	readonly viewBox = { baseVal: { width: 100, height: 100 } };

	constructor(readonly tagName: string) {}

	append(...elements: MockElement[]): void {
		this.children.push(...elements);
	}

	replaceChildren(...elements: MockElement[]): void {
		this.children.splice(0, this.children.length, ...elements);
	}

	setAttribute(name: string, value: string): void {
		this.attributes.set(name, value);
	}

	descendants(): MockElement[] {
		return this.children.flatMap((child) => [child, ...child.descendants()]);
	}

	querySelector(selector: string): MockElement | undefined {
		if (selector === "svg") return this.descendants().find((element) => element.tagName === "svg");
		throw new Error(`Unsupported selector: ${selector}`);
	}

	querySelectorAll(selector: string): MockElement[] {
		if (selector === "g[data-path]") {
			return this.descendants().filter(
				(element) => element.tagName === "g" && element.dataset["path"] !== undefined,
			);
		}
		throw new Error(`Unsupported selector: ${selector}`);
	}
}

function collectText(element: MockElement): string {
	return [element.textContent, ...element.children.map(collectText)].join(" ");
}

function createPreviewHarness() {
	const elements = new Map<string, MockElement>();
	for (const id of [
		"canvas",
		"details",
		"title",
		"meta",
		"zoomLabel",
		"zoomIn",
		"zoomOut",
		"fit",
		"openSource",
		"openGodot",
	]) {
		elements.set(id, new MockElement("div"));
	}
	const listeners = new Map<string, (event: { data?: unknown; message?: string }) => void>();
	const posted: unknown[] = [];
	const document = {
		getElementById: (id: string): MockElement | null => elements.get(id) ?? null,
		createElement: (tagName: string): MockElement => new MockElement(tagName),
		createElementNS: (_namespace: string, tagName: string): MockElement => new MockElement(tagName),
		querySelectorAll: (selector: string): MockElement[] => elements.get("canvas")?.querySelectorAll(selector) ?? [],
		querySelector: (selector: string): MockElement | null =>
			elements.get("canvas")?.querySelector(selector) ?? null,
	};
	const window = {
		addEventListener: (type: string, listener: (event: { data?: unknown; message?: string }) => void): void => {
			listeners.set(type, listener);
		},
	};
	const context = {
		document,
		window,
		title: "Browser window title",
		acquireVsCodeApi: () => ({ postMessage: (message: unknown) => posted.push(message) }),
	};
	new Script(STATIC_PREVIEW_SCRIPT).runInNewContext(context);
	return { context, posted, elements, listeners };
}

describe("static previews", () => {
	it("generates syntactically valid Webview JavaScript for both preview renderers", () => {
		assert.doesNotThrow(() => new Script(STATIC_PREVIEW_SCRIPT));
		assert.match(STATIC_PREVIEW_SCRIPT, /function renderScene\(/);
		assert.match(STATIC_PREVIEW_SCRIPT, /function renderShader\(/);
	});

	it("builds a positioned 2D model with nested controls and a scoped texture URI", () => {
		const root = fs.mkdtempSync(path.join(os.tmpdir(), "ngdt-scene-preview-"));
		try {
			fs.writeFileSync(path.join(root, "project.godot"), "[application]\n");
			fs.mkdirSync(path.join(root, "assets"));
			fs.writeFileSync(path.join(root, "assets", "icon.svg"), '<svg xmlns="http://www.w3.org/2000/svg"/>');
			const scenePath = path.join(root, "main.tscn");
			const source = `[gd_scene load_steps=2 format=3]\n\n[ext_resource type="Texture2D" path="res://assets/icon.svg" id="1_icon"]\n\n[node name="Root" type="Node2D"]\nposition = Vector2(10, 20)\n\n[node name="Sprite" type="Sprite2D" parent="."]\nposition = Vector2(5, 6)\ntexture = ExtResource("1_icon")\n\n[node name="Panel" type="ColorRect" parent="."]\nposition = Vector2(-4, 8)\nsize = Vector2(100, 40)\ncolor = Color(1, 0, 0, 0.5)\n\n[node name="Title" type="Label" parent="Panel"]\nposition = Vector2(2, 3)\ntext = "Hello"\n`;
			fs.writeFileSync(scenePath, source);
			const document = makeDocument(vscode.Uri.file(scenePath), source);
			const scene = new SceneParser().parse_scene(document);
			const webview = {
				asWebviewUri: (uri: vscode.Uri) => vscode.Uri.parse(`https://images.example/${uri.path}`),
			} as unknown as vscode.Webview;
			const model = buildScenePreviewModel(scene, webview);

			assert.equal(model.nodes.length, 1);
			const rootNode = model.nodes[0];
			assert.equal(rootNode.className, "Node2D");
			assert.deepEqual([rootNode.x, rootNode.y], [10, 20]);
			const sprite = rootNode.children.find((node) => node.label === "Sprite");
			assert.ok(sprite);
			assert.equal(sprite.texturePath, "res://assets/icon.svg");
			assert.match(sprite.textureUri ?? "", /^https:\/\/images\.example\//);
			assert.deepEqual([sprite.width, sprite.height], [64, 64]);
			const panel = rootNode.children.find((node) => node.label === "Panel");
			assert.ok(panel);
			assert.deepEqual([panel.x, panel.y, panel.width, panel.height], [-4, 8, 100, 40]);
			assert.equal(panel.children[0]?.text, "Hello");
			assert.equal(panel.children[0]?.position > panel.position, true);
			assert.deepEqual(model.warnings, []);
		} finally {
			fs.rmSync(root, { recursive: true, force: true });
		}
	});

	it("caches duplicate scene texture URI resolution", () => {
		const root = fs.mkdtempSync(path.join(os.tmpdir(), "ngdt-scene-texture-cache-"));
		try {
			fs.writeFileSync(path.join(root, "project.godot"), "[application]\n");
			fs.mkdirSync(path.join(root, "assets"));
			fs.writeFileSync(path.join(root, "assets", "icon.svg"), "<svg/>");
			const scenePath = path.join(root, "cache.tscn");
			const source = `[gd_scene load_steps=2 format=3]\n\n[ext_resource type="Texture2D" path="res://assets/icon.svg" id="1_icon"]\n\n[node name="Root" type="Node2D"]\n\n[node name="First" type="Sprite2D" parent="."]\ntexture = ExtResource("1_icon")\n\n[node name="Second" type="Sprite2D" parent="."]\ntexture = ExtResource("1_icon")\n`;
			fs.writeFileSync(scenePath, source);
			const scene = new SceneParser().parse_scene(makeDocument(vscode.Uri.file(scenePath), source));
			let calls = 0;
			const webview = {
				asWebviewUri: (uri: vscode.Uri) => {
					calls += 1;
					return vscode.Uri.parse(uri.toString());
				},
			} as unknown as vscode.Webview;

			const model = buildScenePreviewModel(scene, webview);
			assert.equal(model.nodes[0]?.children.length, 2);
			assert.equal(calls, 1);
		} finally {
			fs.rmSync(root, { recursive: true, force: true });
		}
	});

	it("extracts canvas shader uniforms and warns for unsupported preview types", () => {
		const uri = vscode.Uri.file(path.join(os.tmpdir(), "preview.gdshader"));
		const model = buildShaderPreviewModel(
			`shader_type canvas_item;\nuniform float strength : hint_range(0., 1.) = 0.5;\nuniform vec4 tint : source_color = vec4(1.0, 0.0, 0.0, 1.0);\n`,
			uri,
		);
		assert.equal(model.shaderType, "canvas_item");
		assert.deepEqual(
			model.uniforms.map((uniform) => [uniform.name, uniform.type, uniform.defaultValue]),
			[
				["strength", "float", "0.5"],
				["tint", "Color", "Color(1, 0, 0, 1)"],
			],
		);
		assert.equal(model.warnings.length, 1);

		const spatial = buildShaderPreviewModel("shader_type spatial;\nuniform sampler2D albedo;\n", uri);
		assert.equal(spatial.shaderType, "spatial");
		assert.equal(spatial.uniforms[0]?.type, "Texture2D");
		assert.match(spatial.warnings[0] ?? "", /canvas_item/);
		assert.match(spatial.warnings[1] ?? "", /does not execute/);
	});

	it("summarizes shader interfaces and reports structural diagnostics", () => {
		const uri = vscode.Uri.file(path.join(os.tmpdir(), "preview.shader"));
		const model = buildShaderPreviewModel(
			"shader_type spatial;\nrender_mode unshaded, cull_disabled;\nuniform float gain : hint_range(0, 2) = 1.0;\nvoid fragment() {\n",
			uri,
		);
		assert.deepEqual(model.renderModes, ["unshaded", "cull_disabled"]);
		assert.deepEqual(model.functions, ["fragment"]);
		assert.equal(model.uniforms[0]?.hint, "range");
		assert.equal(model.diagnostics[0]?.message, "Unclosed shader block.");
		assert.equal(model.diagnostics[0]?.line, 4);
	});

	it("ignores commented shader syntax and reports the original line", () => {
		const uri = vscode.Uri.file(path.join(os.tmpdir(), "commented.shader"));
		const model = buildShaderPreviewModel(
			"shader_type canvas_item; // render_mode bogus;\n/* void fake() { */\nvoid fragment() {\n  COLOR = vec4(1.0);\n}\n",
			uri,
		);
		assert.deepEqual(model.functions, ["fragment"]);
		assert.deepEqual(model.renderModes, []);
		assert.deepEqual(model.diagnostics, []);
	});

	it("counts shader lines for empty, LF, and CRLF sources", () => {
		assert.equal(analyzeShaderSource("").lineCount, 1);
		assert.equal(analyzeShaderSource("shader_type canvas_item;\nvoid fragment() {}\n").lineCount, 3);
		assert.equal(analyzeShaderSource("shader_type canvas_item;\r\nvoid fragment() {}\r\n").lineCount, 3);
	});

	it("accepts only supported preview messages", () => {
		assert.equal(isPreviewMessage({ command: "ready" }), true);
		assert.equal(isPreviewMessage({ command: "openGodot" }), true);
		assert.equal(isPreviewMessage({ command: "openSource", position: 12 }), true);
		assert.equal(isPreviewMessage({ command: "openSource", position: 1.5 }), false);
		assert.equal(isPreviewMessage({ command: "openSource" }), false);
		assert.equal(isPreviewMessage(null), false);
	});

	it("preserves local transforms for rotated and scaled nodes", () => {
		const root = fs.mkdtempSync(path.join(os.tmpdir(), "ngdt-scene-transform-"));
		try {
			fs.writeFileSync(path.join(root, "project.godot"), "[application]\\n");
			const scenePath = path.join(root, "transform.tscn");
			const source = `[gd_scene load_steps=1 format=3]\n\n[node name="Root" type="Node2D"]\n\n[node name="Rotated" type="ColorRect" parent="."]\nposition = Vector2(10, 20)\nrotation = 1.5707963\nscale = Vector2(2, 0.5)\nsize = Vector2(30, 40)\n`;
			fs.writeFileSync(scenePath, source);
			const scene = new SceneParser().parse_scene(makeDocument(vscode.Uri.file(scenePath), source));
			const model = buildScenePreviewModel(scene);
			const node = model.nodes[0]?.children[0];
			assert.ok(node);
			assert.deepEqual([node.x, node.y], [10, 20]);
			assert.deepEqual([node.scaleX, node.scaleY], [2, 0.5]);
			assert.ok(Math.abs(node.rotation - 90) < 0.001);
		} finally {
			fs.rmSync(root, { recursive: true, force: true });
		}
	});

	it("boots the real preview script and renders a message without a title global collision", () => {
		const harness = createPreviewHarness();
		assert.equal(harness.posted.length, 1);
		assert.equal((harness.posted[0] as { command?: string }).command, "ready");

		const dispatch = harness.listeners.get("message");
		assert.ok(dispatch);
		dispatch({
			data: {
				type: "model",
				model: {
					kind: "scene",
					uri: "file:///example.tscn",
					title: "Example scene",
					error: undefined,
					warnings: [],
					nodes: [
						{
							path: ".",
							className: "Node2D",
							label: "Root",
							position: 0,
							x: 10,
							y: 20,
							width: 100,
							height: 60,
							rotation: 0,
							scaleX: 1,
							scaleY: 1,
							color: "rgba(1,2,3,0.5)",
							properties: [],
							children: [],
						},
					],
				},
			},
		});

		assert.equal(harness.context.title, "Browser window title");
		assert.equal(harness.elements.get("title")?.textContent, "Example scene");
		assert.equal(harness.elements.get("canvas")?.querySelector("svg")?.tagName, "svg");
		assert.equal(harness.elements.get("canvas")?.querySelectorAll("g[data-path]").length, 1);
		harness.elements.get("openGodot")?.onclick?.({ stopPropagation: () => undefined });
		assert.equal((harness.posted[1] as { command?: string }).command, "openGodot");
	});

	it("renders a truthful shader capability sheet and a visible empty scene state", () => {
		const harness = createPreviewHarness();
		const dispatch = harness.listeners.get("message");
		assert.ok(dispatch);
		dispatch({
			data: {
				type: "model",
				model: {
					kind: "shader",
					uri: "file:///example.gdshader",
					shaderType: "canvas_item",
					renderModes: ["blend_mix"],
					uniforms: [{ name: "tint", type: "Color", defaultValue: "Color(1, 0, 0, 1)" }],
					functions: ["fragment"],
					lineCount: 7,
					diagnostics: [],
					warnings: ["The browser preview does not execute Godot shader code."],
				},
			},
		});
		const shaderText = collectText(harness.elements.get("canvas") as MockElement);
		assert.match(shaderText, /not executed here/);
		assert.match(shaderText, /not rendered material output/);
		assert.doesNotMatch(shaderText, /material$/);

		dispatch({
			data: {
				type: "model",
				model: { kind: "scene", uri: "file:///empty.tscn", title: "Empty", nodes: [], warnings: [] },
			},
		});
		const emptyText = collectText(harness.elements.get("canvas") as MockElement);
		assert.match(emptyText, /No scene nodes found/);
	});

	it("renders only shader stages with a standalone Godot surface", () => {
		assert.deepEqual(nativeRenderSupport("scene", "/project/main.tscn", "[gd_scene]"), { supported: true });
		for (const stage of ["canvas_item", "spatial", "sky"]) {
			assert.deepEqual(nativeRenderSupport("shader", "/project/effect.gdshader", `shader_type ${stage};\n`), {
				supported: true,
			});
		}
		const include = nativeRenderSupport("shader", "/project/shared.gdshaderinc", "float gain = 1.0;\n");
		assert.equal(include.supported, false);
		assert.match(include.supported === false ? include.message : "", /include files/);
		const missing = nativeRenderSupport("shader", "/project/effect.gdshader", "uniform float gain;\n");
		assert.equal(missing.supported, false);
		assert.match(missing.supported === false ? missing.message : "", /Add a shader_type declaration/);
		const particles = nativeRenderSupport("shader", "/project/sparks.gdshader", "shader_type particles;\n");
		assert.equal(particles.supported, false);
		assert.match(particles.supported === false ? particles.message : "", /particles shaders/);
		assert.match(
			particles.supported === false ? particles.message : "",
			/Canvas, spatial, and sky shaders render natively/,
		);
	});

	it("shows the native Godot frame with a caption and keeps manual zoom across re-renders", () => {
		const harness = createPreviewHarness();
		const dispatch = harness.listeners.get("message");
		assert.ok(dispatch);
		dispatch({
			data: {
				type: "model",
				model: {
					kind: "scene",
					uri: "file:///example.tscn",
					title: "Example scene",
					warnings: [],
					nodes: [
						{
							path: ".",
							className: "Node2D",
							label: "Root",
							position: 0,
							x: 0,
							y: 0,
							width: 100,
							height: 100,
							rotation: 0,
							scaleX: 1,
							scaleY: 1,
							color: "rgba(1,2,3,0.5)",
							properties: [],
							children: [],
						},
					],
				},
			},
		});
		dispatch({
			data: {
				type: "render",
				state: "ready",
				engine: "4",
				ms: 42,
				width: 960,
				height: 540,
				imageUri: "https://example/render.png",
			},
		});

		const canvas = harness.elements.get("canvas") as MockElement;
		const figure = canvas.children[0] as MockElement;
		assert.equal(figure.tagName, "figure");
		assert.equal(figure.className, "native-frame");
		const image = figure.children[0] as MockElement;
		assert.equal(image.tagName, "img");
		assert.equal(image.className, "native-render");
		assert.equal(image.src, "https://example/render.png");
		assert.equal(image.style["width"], "720px", "the fitted zoom uses the viewport width");
		assert.equal(figure.children[1]?.textContent, "Godot 4 render · 960 × 540 · 42 ms");
		assert.equal(harness.elements.get("zoomLabel")?.textContent, "75%");
		const meta = harness.elements.get("meta") as MockElement;
		assert.equal(meta.dataset["state"], "ready");
		assert.match(meta.textContent, /Godot render · 42 ms/);

		harness.elements.get("zoomOut")?.onclick?.({ stopPropagation: () => undefined });
		assert.equal((canvas.children[0] as MockElement).children[0]?.style["width"], "576px");
		dispatch({
			data: {
				type: "render",
				state: "ready",
				engine: "4",
				width: 480,
				height: 270,
				imageUri: "https://example/second.png",
			},
		});
		assert.equal(
			(canvas.children[0] as MockElement).children[0]?.style["width"],
			"288px",
			"a manual zoom survives the next native render",
		);
		assert.equal(harness.elements.get("zoomLabel")?.textContent, "60%");

		harness.elements.get("fit")?.onclick?.({ stopPropagation: () => undefined });
		assert.equal((canvas.children[0] as MockElement).children[0]?.style["width"], "720px");
		assert.equal(harness.elements.get("zoomLabel")?.textContent, "150%");
	});

	it("labels shader output and reports a failed native render honestly", () => {
		const harness = createPreviewHarness();
		const dispatch = harness.listeners.get("message");
		assert.ok(dispatch);
		dispatch({
			data: {
				type: "model",
				model: {
					kind: "shader",
					uri: "file:///example.gdshader",
					shaderType: "spatial",
					renderModes: [],
					uniforms: [],
					functions: ["fragment"],
					lineCount: 3,
					diagnostics: [],
					warnings: [],
				},
			},
		});
		dispatch({
			data: {
				type: "render",
				state: "ready",
				engine: "3",
				width: 960,
				height: 540,
				imageUri: "https://example/shader.png",
			},
		});
		const canvas = harness.elements.get("canvas") as MockElement;
		assert.equal((canvas.children[0] as MockElement).children[1]?.textContent, "Godot 3 render · 960 × 540");
		assert.equal(collectText(harness.elements.get("details") as MockElement).includes("Shader output"), true);

		dispatch({ data: { type: "render", state: "failed", message: "Godot could not load this scene." } });
		const meta = harness.elements.get("meta") as MockElement;
		assert.equal(meta.dataset["state"], "failed");
		assert.equal(meta.title, "Godot could not load this scene.");
		assert.match(meta.textContent, /Godot render failed/);
		assert.match(collectText(canvas), /spatial shader/, "the static sheet returns when the native render fails");

		dispatch({ data: { type: "render", state: "unavailable", message: "Sky shaders need Godot 4." } });
		assert.equal(meta.dataset["state"], "static");
		assert.equal(meta.title, "Sky shaders need Godot 4.");
		assert.match(meta.textContent, /static preview/);
	});

	it("guards the preview shell with responsive theme-aware CSS and an IIFE entry point", () => {
		assert.match(STATIC_PREVIEW_SCRIPT, /titleElement\.textContent/);
		assert.doesNotMatch(STATIC_PREVIEW_SCRIPT, /\btitle\.textContent/);
		assert.match(STATIC_PREVIEW_SCRIPT, /\}\)\(\);$/);
		assert.match(STATIC_PREVIEW_CSS, /color-scheme:light dark/);
		assert.match(STATIC_PREVIEW_CSS, /@media\(max-width:680px\)/);
		assert.match(STATIC_PREVIEW_CSS, /overflow-wrap:anywhere/);
	});
});
