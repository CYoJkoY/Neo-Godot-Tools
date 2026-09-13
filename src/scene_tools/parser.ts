import * as fs from "node:fs";
import { createHash } from "node:crypto";
import { basename, dirname, extname, isAbsolute, resolve } from "node:path";
import { TextDocument, Uri, workspace } from "vscode";
import { SceneNode, Scene, SceneResource } from "./types";
import { createLogger } from "../utils";

const log = createLogger("scenes.parser");

export class SceneParser {
	private static instance: SceneParser;
	private preparingScenes = new Set<string>();
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
		this.prepare_scene(scene);
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

	private prepare_scene(scene: Scene): void {
		const sceneKey = scene.path || scene.title;
		if (this.preparingScenes.has(sceneKey)) return;
		this.preparingScenes.add(sceneKey);

		try {
			for (const node of scene.nodes.values()) {
				if (!node.resourcePath || extname(node.resourcePath) !== ".tscn") continue;
				const resolved = this.resolve_resource_path(scene.path, node.resourcePath);
				if (!resolved) continue;

				const referenced = this.parse_file(resolved);
				if (!referenced) continue;
				node.instanceScene = referenced;
				this.prepare_scene(referenced);
			}

			this.expand_instanced_nodes(scene, new Set<string>());
			this.rebuild_tree(scene);
			this.resolve_node_types(scene);
		} finally {
			this.preparingScenes.delete(sceneKey);
		}
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
			const id = line.match(/\bid\s*=\s*"?([^"\s\]]+)"?/)?.[1] ?? "";

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
			const id = line.match(/\bid\s*=\s*"?([^"\s\]]+)"?/)?.[1] ?? "";
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

	/**
	 * Materialize the effective node tree of inherited/instanced scenes.
	 *
	 * A TSCN stores only the nodes and overrides owned by the current scene.
	 * PackedScene instances contribute their own root and descendants to the
	 * effective tree. The preview therefore needs to merge those descendants
	 * without confusing an instance boundary with a new local root.
	 */
	private expand_instanced_nodes(scene: Scene, visited: Set<string>): void {
		const sceneKey = scene.path || scene.title;
		if (visited.has(sceneKey)) return;
		visited.add(sceneKey);

		for (const node of [...scene.nodes.values()]) {
			if (!node.instanceScene?.root) continue;
			this.expand_instanced_nodes(node.instanceScene, visited);

			for (const child of node.instanceScene.root.children) {
				this.merge_instanced_node(scene, node, child);
			}
		}
	}

	private merge_instanced_node(scene: Scene, instanceRoot: SceneNode, source: SceneNode): SceneNode {
		const relativePath = this.relative_to_root(source);
		const targetPath = `${instanceRoot.path}/${relativePath}`;
		const existing = scene.nodes.get(targetPath);

		if (existing) {
			this.merge_inherited_metadata(existing, source);
			for (const child of source.children) {
				this.merge_instanced_node(scene, existing, child);
			}
			return existing;
		}

		const imported = this.clone_instanced_node(source, instanceRoot, targetPath);
		scene.nodes.set(targetPath, imported);
		instanceRoot.children.push(imported);

		for (const child of source.children) {
			this.merge_instanced_node(scene, imported, child);
		}
		return imported;
	}

	private relative_to_root(node: SceneNode): string {
		const rootPath = node.path.split("/")[0];
		return node.path.slice(rootPath.length + 1);
	}

	private clone_instanced_node(source: SceneNode, parent: SceneNode, targetPath: string): SceneNode {
		const imported = new SceneNode(source.label, source.className);
		imported.path = targetPath;
		imported.relativePath = targetPath.slice(parent.path.length + 1);
		imported.parent = parent.path;
		imported.text = source.text;
		imported.position = -1;
		imported.body = source.body;
		imported.unique = source.unique;
		imported.hasScript = source.hasScript;
		imported.scriptId = source.scriptId;
		imported.customTypeScriptUid = source.customTypeScriptUid;
		imported.customTypeScriptId = source.customTypeScriptId;
		imported.customTypeScriptSubResourceId = source.customTypeScriptSubResourceId;
		imported.explicitType = source.explicitType;
		imported.inheritedFromScene = true;
		imported.resourcePath = source.resourcePath;
		imported.instanceScene = source.instanceScene;
		imported.contextValue = source.contextValue;
		imported.tooltip = source.tooltip;
		imported.resourceUri = Uri.from({ scheme: "godot", path: targetPath });
		return imported;
	}

	private merge_inherited_metadata(target: SceneNode, source: SceneNode): void {
		if (!target.explicitType) target.setClassName(source.className);
		if (!target.scriptId && source.scriptId) target.scriptId = source.scriptId;
		if (!target.hasScript && source.hasScript) target.hasScript = true;
		if (!target.customTypeScriptUid && source.customTypeScriptUid) target.customTypeScriptUid = source.customTypeScriptUid;
		if (!target.customTypeScriptId && source.customTypeScriptId) target.customTypeScriptId = source.customTypeScriptId;
		if (!target.customTypeScriptSubResourceId && source.customTypeScriptSubResourceId) target.customTypeScriptSubResourceId = source.customTypeScriptSubResourceId;
		if (!target.resourcePath && source.resourcePath) target.resourcePath = source.resourcePath;
		if (!target.instanceScene && source.instanceScene) target.instanceScene = source.instanceScene;
		if (source.unique) target.unique = true;
		if (source.hasScript && !target.contextValue?.includes("hasScript")) target.contextValue = `${target.contextValue ?? ""}hasScript`;
		target.inheritedFromScene ||= source.inheritedFromScene;
	}

	/** Reconstruct parent/child relationships from canonical node paths. */
	private rebuild_tree(scene: Scene): void {
		for (const node of scene.nodes.values()) node.children = [];
		if (!scene.root) return;

		for (const node of scene.nodes.values()) {
			if (node === scene.root || !node.parent) continue;
			const parent = scene.nodes.get(node.parent);
			if (parent) parent.children.push(node);
		}
	}

	private resolve_node_types(scene: Scene): void {
		const nodes = Object.fromEntries(scene.nodes.entries());
		for (const node of scene.nodes.values()) {
			const inheritedType = this.resolve_inherited_node_type(node.parent ? nodes[node.parent] : undefined, node.path, nodes);
			const instanceType = node.instanceScene?.root?.className;
			const customType = this.resolve_custom_type(scene, node);
			const type = customType || node.explicitType || inheritedType || instanceType || (node.inheritedFromScene ? node.className : undefined) || "Node";
			node.setClassName(type);
			node.description = type;
		}
	}

	private resolve_custom_type(scene: Scene, node: SceneNode): string | undefined {
		let resource: GDResourceLike | undefined;
		if (node.customTypeScriptId) resource = scene.externalResources.get(node.customTypeScriptId);
		if (!resource && node.customTypeScriptUid) resource = [...scene.externalResources.values()].find((item) => item.uid === node.customTypeScriptUid);
		if (!resource && node.customTypeScriptSubResourceId) {
			const subResource = scene.subResources.get(node.customTypeScriptSubResourceId);
			const scriptId = subResource?.body.match(/(?:^|\n)script\s*=\s*ExtResource\(\s*"?([^\)"\s]+)"?\s*\)/)?.[1];
			if (scriptId) resource = scene.externalResources.get(scriptId);
		}
		if (!resource && node.scriptId) resource = scene.externalResources.get(node.scriptId);
		if (!resource || resource.type !== "Script" || !resource.path) return undefined;

		const scriptPath = this.resolve_resource_path(scene.path, resource.path);
		if (!scriptPath || !fs.existsSync(scriptPath)) return undefined;
		return this.resolve_script_type(scriptPath, new Set<string>());
	}

	private resolve_script_type(scriptPath: string, visited: Set<string>): string | undefined {
		if (visited.has(scriptPath)) return undefined;
		visited.add(scriptPath);
		try {
			const source = fs.readFileSync(scriptPath, "utf8");
			const className = source.match(/^\s*class_name\s+([A-Za-z_]\w*)/m)?.[1];
			if (className) return className;

			const extendsMatch = source.match(/^\s*extends\s+(?:["']([^"']+)["']|([A-Za-z_]\w*))/m);
			if (!extendsMatch) return undefined;
			const base = extendsMatch[1] ?? extendsMatch[2];
			if (!base) return undefined;
			if (base.startsWith("res://") || base.endsWith(".gd")) {
				const parentPath = this.resolve_resource_path(scriptPath, base);
				return parentPath ? this.resolve_script_type(parentPath, visited) : undefined;
			}
			return base;
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

type GDResourceLike = { type: string; path: string; uid: string; id: string; body: string; index: number; line: number };
