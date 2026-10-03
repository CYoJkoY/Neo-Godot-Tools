import { TreeItem, TreeItemCollapsibleState, MarkdownString, Uri } from "vscode";
import type { SceneProperty } from "./properties";
import * as path from "node:path";
import { get_extension_uri } from "../utils";
import * as fs from "node:fs";
const DEFAULT_NODE_ICON = "Node";

const iconDir = get_extension_uri("resources", "godot_icons").fsPath;

export class SceneNode extends TreeItem {
	public path: string;
	public relativePath: string;
	public resourcePath: string;
	public parent: string;
	public text: string;
	public position: number;
	/** Offset where the next section of the scene starts. */
	public bodyEnd = -1;
	/** Overridden properties of this node, as written in the scene file. */
	public properties: SceneProperty[] = [];
	public body: string;
	public unique = false;
	public hasScript = false;
	public scriptId = "";
	public customTypeScriptUid = "";
	public customTypeScriptId = "";
	public customTypeScriptSubResourceId = "";
	public explicitType = "";
	public inheritedFromScene = false;
	public children: SceneNode[] = [];
	public instanceScene?: Scene;

	constructor(
		public label: string,
		public className: string,
		public collapsibleState?: TreeItemCollapsibleState,
	) {
		super(label, collapsibleState);
		this.update_icon();
	}

	public setClassName(className: string): void {
		if (this.className === className) return;
		this.className = className;
		this.update_icon();
	}

	public parse_body() {
		const lines = this.body.split("\n");
		const newLines: string[] = [];
		for (let i = 0; i < lines.length; i++) {
			let line = lines[i];
			if (line.startsWith("tile_data")) line = "tile_data = PoolIntArray(...)";
			if (line.startsWith("unique_name_in_owner = true")) this.unique = true;
			if (line.startsWith("metadata/_custom_type_script = ")) {
				const value = line.slice(line.indexOf("=") + 1).trim();
				this.customTypeScriptUid = value.match(/^"(uid:\/\/[^\"]+)"$/)?.[1] ?? "";
				this.customTypeScriptId = value.match(/^ExtResource\(\s*"?([^\)"\s]+)"?\s*\)$/)?.[1] ?? "";
				this.customTypeScriptSubResourceId = value.match(/^SubResource\(\s*"?([^\)"\s]+)"?\s*\)$/)?.[1] ?? "";
				if (this.customTypeScriptUid || this.customTypeScriptId || this.customTypeScriptSubResourceId) {
					this.hasScript = true;
					this.contextValue += "hasScript";
				}
			}
			if (line.startsWith("script = ExtResource")) {
				this.hasScript = true;
				this.scriptId = line.match(/script = ExtResource\(\s*"?([\w.-]+)"?\s*\)/)?.[1] ?? "";
				this.contextValue += "hasScript";
			}
			if (line !== "") newLines.push(line);
		}
		this.body = newLines.join("\n");
		const content = new MarkdownString();
		content.appendCodeblock(this.body, "gdresource");
		this.tooltip = content;
	}

	public iconClass = "";

	public setIconClass(className: string): void {
		if (this.iconClass === className) return;
		this.iconClass = className;
		this.update_icon();
	}

	private update_icon(): void {
		const iconName = `${this.iconClass || this.className}.svg`;
		if (
			!fs.existsSync(path.join(iconDir, "light", iconName)) &&
			!fs.existsSync(path.join(iconDir, "dark", iconName))
		) {
			if (!this.iconClass && !fs.existsSync(path.join(iconDir, "light", `${this.className}.svg`))) {
				this.setIconClass(DEFAULT_NODE_ICON);
				return;
			}
			this.iconPath = undefined;
			return;
		}
		this.iconPath = {
			light: Uri.file(path.join(iconDir, "light", iconName)),
			dark: Uri.file(path.join(iconDir, "dark", iconName)),
		};
	}
}

export interface GDResource {
	path: string;
	type: string;
	id: string;
	uid: string;
	body: string;
	index: number;
	line: number;
}

export class Scene {
	public path: string;
	public title: string;
	public mtime: number;
	/** Raw text of the scene file, used to compute property edits. */
	public source = "";
	public sourceFingerprint = "";
	public root: SceneNode | undefined;
	public externalResources: Map<string, GDResource> = new Map();
	public subResources: Map<string, GDResource> = new Map();
	public nodes: Map<string, SceneNode> = new Map();
}

/** Properties of a node, grouped in the Scene Preview tree. */
export class ScenePropertiesGroup extends TreeItem {
	constructor(public node: SceneNode) {
		super("Properties", TreeItemCollapsibleState.Collapsed);
		this.description = node.properties.length ? String(node.properties.length) : "none";
		this.contextValue = "sceneProperties";
		this.tooltip = node.properties.length
			? "Overridden properties of this node"
			: "This node overrides no properties";
	}
}

/** One editable property of a node. */
export class ScenePropertyItem extends TreeItem {
	constructor(
		public node: SceneNode,
		public property: SceneProperty,
		label?: string,
	) {
		super(label ?? "", TreeItemCollapsibleState.None);
		this.label = property.name;
		this.description = property.raw.length > 80 ? `${property.raw.slice(0, 77)}...` : property.raw;
		this.contextValue = "sceneProperty";
		this.tooltip = new MarkdownString(`\`\`\`gdresource\n${property.name} = ${property.raw}\n\`\`\``);
	}
}

export interface SceneResource {
	path: string;
	type: string;
	uid: string;
	id: string;
	index: number;
	line: number;
	body: string;
}
