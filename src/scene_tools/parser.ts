import * as fs from "node:fs";
import { createHash } from "node:crypto";
import { basename, dirname, extname, isAbsolute, resolve } from "node:path";
import { TextDocument, Uri, workspace } from "vscode";
import { SceneNode, Scene, SceneResource } from "./types";
import { createLogger } from "../utils";

const log = createLogger("scenes.parser");

export class SceneParser {
	private static instance: SceneParser;
	public scenes: Map<string, Scene> = new Map();

	constructor() {
		if (SceneParser.instance) {
			// biome-ignore lint/correctness/noConstructorReturn: <explanation>
			return SceneParser.instance;
		}
		SceneParser.instance = this;
	}

	public parse_scene(document: TextDocument): Scene {
		const filePath = document.uri.fsPath;
		const scene = this.parse_text(filePath, document.getText(), (offset) => document.lineAt(document.positionAt(offset)).lineNumber + 1);
		this.refresh_instanced_scenes(scene, new Set<string>());
		this.resolve_node_types(scene);
		return scene;
	}

	private parse_file(filePath: string): Scene | undefined {
		if (!fs.existsSync(filePath)) return undefined;

		const stats = fs.statSync(filePath);
		const existing = this.scenes.get(filePath);
		if (existing && existing.mtime === stats.mtimeMs) return existing;

		let text: string;
		try {
			text = fs.readFileSync(filePath, "utf8");
		} catch (error) {
			log.debug(`Unable to read referenced scene ${filePath}: ${String(error)}`);
			return undefined;
		}

		return this.parse_text(filePath, text, (offset) => text.slice(0, offset).split(/\r?\n/).length);
	}

	private parse_text(filePath: string, text: string, lineAtOffset: (offset: number) => number): Scene {
		const stats = fs.statSync(filePath);
		const sourceFingerprint = createHash("sha1").update(text).digest("hex");
		const existing = this.scenes.get(filePath);
		if (existing && existing.mtime === stats.mtimeMs && existing.sourceFingerprint === sourceFingerprint) return existing;

		const scene = new Scene();
		scene.path = filePath;
		scene.mtime = stats.mtimeMs;
		scene.sourceFingerprint = sourceFingerprint;
		scene.title = basename(filePath);
		this.scenes.set(filePath, scene);

		for (const match of text.matchAll(/\[ext_resource[^\n]*/g)) {
			const line = match[0];
			const type = line.match(/type="([^"]+)"/)?.[1] ?? "";
			const resPath = line.match(/path="([^"]+)"/)?.[1] ?? "";
			const uid = line.match(/uid="([^"]+)"/)?.[1] ?? "";
			const id = line.match(/\bid="?([^"\s]+)"?/)?.[1] ?? "";

			if (id && match.index !== undefined) {
				scene.externalResources.set(id, {
					body: line,
					path: resPath,
					type,
					uid,
					id,
					index: match.index,
					line: lineAtOffset(match.index),
				});
			}
		}

		let lastResource: SceneResource | undefined;
		for (const match of text.matchAll(/\[sub_resource[^\n]*/g)) {
			if (match.index === undefined) continue;
			const line = match[0];
			const type = line.match(/type="([^"]+)"/)?.[1] ?? "";
			const resPath = line.match(/path="([^"]+)"/)?.[1] ?? "";
			const uid = line.match(/uid="([^"]+)"/)?.[1] ?? "";
			const id = line.match(/\bid="?([^"\s]+)"?/)?.[1] ?? "";
			const resource: SceneResource = {
				path: resPath,
				type,
				uid,
				id,
				index: match.index,
				line: lineAtOffset(match.index),
				body: "",
			};
			if (lastResource) lastResource.body = text.slice(lastResource.index, match.index).trimEnd();
			if (id) scene.subResources.set(id, resource);
			lastResource = resource;
		}

		let root = "";
		const nodes: Record<string, SceneNode> = {};
		let lastNode: SceneNode | undefined;

		for (const match of text.matchAll(/\[node[^\n]*/g)) {
			if (match.index === undefined) continue;
			const line = match[0];
			const name = line.match(/name="([^"]+)"/)?.[1] || "unknown";
			const explicitType = line.match(/type="([^"]+)"/)?.[1] ?? "";
			let parent = line.match(/parent="([^"]+)"/)?.[1];
			const instance = line.match(/instance=ExtResource\(\s*"?([^\)"\s]+)"?\s*\)/)?.[1];

			let nodePath = "";
			let relativePath = "";
			if (parent === undefined) {
				root = name;
				nodePath = name;
				parent = "";
			} else if (parent === ".") {
				parent = root;
				relativePath = name;
				nodePath = `${parent}/${name}`;
			} else {
				relativePath = `${parent}/${name}`;
				parent = `${root}/${parent}`;
				nodePath = `${parent}/${name}`;
			}

			if (lastNode) {
				lastNode.body = text.slice(lastNode.position, match.index);
				lastNode.parse_body();
			}
			if (lastResource) {
				lastResource.body = text.slice(lastResource.index, match.index).trimEnd();
				lastResource = undefined;
			}

			const parentNode = parent ? nodes[parent] : undefined;
			const instanceResource = instance ? scene.externalResources.get(instance) : undefined;
			const instanceScene = instanceResource ? this.load_instanced_scene(filePath, instanceResource.path) : undefined;
			const inheritedType = this.resolve_inherited_node_type(parentNode, nodePath, nodes);
			const type = explicitType || inheritedType || instanceScene?.root?.className || "Node";

			const node = new SceneNode(name, type);
			node.explicitType = explicitType;
			node.path = nodePath;
			node.description = type;
			node.relativePath = relativePath;
			node.parent = parent;
			node.text = line;
			node.position = match.index;
			node.instanceScene = instanceScene;
			node.resourceUri = Uri.from({ scheme: "godot", path: nodePath });
			scene.nodes.set(nodePath, node);

			if (instanceResource) {
				node.tooltip = instanceResource.path;
				node.resourcePath = instanceResource.path;
				if (extname(node.resourcePath) === ".tscn") node.contextValue += "openable";
				node.contextValue += "hasResourcePath";
			}
			if (nodePath === root) scene.root = node;
			if (parentNode) parentNode.children.push(node);
			nodes[nodePath] = node;
			lastNode = node;
		}

		if (lastNode) {
			lastNode.body = text.slice(lastNode.position);
			lastNode.parse_body();
		}

		if (lastResource) lastResource.body = text.slice(lastResource.index).trimEnd();
		this.resolve_node_types(scene);
		return scene;
	}

	private load_instanced_scene(filePath: string, resourcePath: string): Scene | undefined {
		const resolved = this.resolve_resource_path(filePath, resourcePath);
		if (!resolved || extname(resolved) !== ".tscn") return undefined;
		return this.parse_file(resolved);
	}

	private resolve_resource_path(filePath: string, resourcePath: string): string | undefined {
		if (!resourcePath) return undefined;
		if (resourcePath.startsWith("res://")) {
			const folder = workspace.getWorkspaceFolder(Uri.file(filePath));
			if (!folder) return undefined;
			return resolve(folder.uri.fsPath, resourcePath.slice("res://".length));
		}
		if (resourcePath.startsWith("user://")) return undefined;
		if (isAbsolute(resourcePath)) return resourcePath;
		return resolve(dirname(filePath), resourcePath);
	}

	private refresh_instanced_scenes(scene: Scene, visited: Set<string>): void {
		const sceneKey = scene.path || scene.title;
		if (visited.has(sceneKey)) return;
		visited.add(sceneKey);

		for (const node of scene.nodes.values()) {
			if (!node.resourcePath || extname(node.resourcePath) !== ".tscn") continue;
			const resolved = this.resolve_resource_path(scene.path, node.resourcePath);
			if (!resolved) continue;
			const refreshed = this.parse_file(resolved);
			if (refreshed) node.instanceScene = refreshed;
			if (node.instanceScene) this.refresh_instanced_scenes(node.instanceScene, visited);
		}
	}

	private resolve_node_types(scene: Scene): void {
		const nodes = Object.fromEntries(scene.nodes.entries());
		for (const node of scene.nodes.values()) {
			const inheritedType = this.resolve_inherited_node_type(node.parent ? nodes[node.parent] : undefined, node.path, nodes);
			const instanceType = node.instanceScene?.root?.className;
			const customType = this.resolve_custom_type(scene, node);
			const type = customType || node.explicitType || inheritedType || instanceType || "Node";
			node.setClassName(type);
			node.description = type;
		}
	}

	private resolve_custom_type(scene: Scene, node: SceneNode): string | undefined {
		if (!node.customTypeScriptUid) return undefined;
		const resource = [...scene.externalResources.values()].find((item) => item.uid === node.customTypeScriptUid);
		if (!resource || !resource.path) return undefined;
		const scriptPath = this.resolve_resource_path(scene.path, resource.path);
		if (!scriptPath || !fs.existsSync(scriptPath)) return undefined;
		try {
			const source = fs.readFileSync(scriptPath, "utf8");
			return source.match(/^\s*class_name\s+([A-Za-z_]\w*)/m)?.[1];
		} catch {
			return undefined;
		}
	}

	private resolve_inherited_node_type(parentNode: SceneNode | undefined, nodePath: string, nodes: Record<string, SceneNode>): string | undefined {
		let owner = parentNode;
		while (owner) {
			if (owner.instanceScene) {
				const relative = nodePath === owner.path ? "." : nodePath.slice(owner.path.length + 1);
				return this.find_instanced_node_type(owner.instanceScene, relative, new Set<string>());
			}
			owner = owner.parent ? nodes[owner.parent] : undefined;
		}
		return undefined;
	}

	private find_instanced_node_type(scene: Scene, relativePath: string, visited: Set<string>): string | undefined {
		const sceneKey = scene.path || scene.title;
		if (visited.has(sceneKey)) return undefined;
		visited.add(sceneKey);

		const root = scene.root;
		if (!root) return undefined;
		if (relativePath === "." || relativePath === "") return root.className;

		const directPath = `${root.path}/${relativePath}`;
		const direct = scene.nodes.get(directPath);
		if (direct) return direct.className;

		if (root.instanceScene) {
			const nestedType = this.find_instanced_node_type(root.instanceScene, relativePath, visited);
			if (nestedType) return nestedType;
		}

		const segments = relativePath.split("/").filter(Boolean);
		let currentPath = root.path;
		for (let index = 0; index < segments.length; index++) {
			currentPath = `${currentPath}/${segments[index]}`;
			const current = scene.nodes.get(currentPath);
			if (!current?.instanceScene) continue;

			const remaining = segments.slice(index + 1).join("/");
			const nestedType = this.find_instanced_node_type(current.instanceScene, remaining || ".", visited);
			if (nestedType) return nestedType;
		}

		return undefined;
	}
}
