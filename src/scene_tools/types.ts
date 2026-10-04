import * as fs from "node:fs";
import * as path from "node:path";
import { MarkdownString, TreeItem, TreeItemCollapsibleState, Uri } from "vscode";
import { get_extension_uri } from "../utils";
import type { SceneProperty } from "./properties";
const DEFAULT_NODE_ICON = "Node";

const iconDir = get_extension_uri("resources", "godot_icons").fsPath;

/** Everything the parser knows when it creates a node. */
export interface SceneNodeInit {
	label: string;
	className: string;
	/** Canonical path inside the scene, e.g. `Player/Sprite`. */
	path: string;
	relativePath: string;
	parent: string;
	/** The raw `[node ...]` header line. */
	text: string;
	/** Offset of the header, or -1 for a node cloned from an instanced scene. */
	position: number;
	/** Offset of the next section, or -1 while it is still unknown. */
	bodyEnd?: number;
}

export class SceneNode extends TreeItem {
	public override label: string;
	public className: string;
	public path: string;
	public relativePath: string;
	public parent: string;
	public text: string;
	public position: number;
	/** Offset where the next section of the scene starts. */
	public bodyEnd: number;
	/** Overridden properties of this node, as written in the scene file. */
	public properties: SceneProperty[] = [];
	public body = "";
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
	/** Set for nodes that instance another scene. */
	public resourcePath?: string;
	public iconClass = "";

	constructor(init: SceneNodeInit) {
		super(init.label, TreeItemCollapsibleState.None);
		this.label = init.label;
		this.className = init.className;
		this.path = init.path;
		this.relativePath = init.relativePath;
		this.parent = init.parent;
		this.text = init.text;
		this.position = init.position;
		this.bodyEnd = init.bodyEnd ?? -1;
		this.update_icon();
	}

	public setClassName(className: string): void {
		if (this.className === className) return;
		this.className = className;
		this.update_icon();
	}

	public parse_body(): void {
		const lines = this.body.split("\n");
		const newLines: string[] = [];
		for (const raw of lines) {
			let line = raw;
			if (line.startsWith("tile_data")) line = "tile_data = PoolIntArray(...)";
			if (line.startsWith("unique_name_in_owner = true")) this.unique = true;
			if (line.startsWith("metadata/_custom_type_script = ")) {
				const value = line.slice(line.indexOf("=") + 1).trim();
				this.customTypeScriptUid = value.match(/^"(uid:\/\/[^"]+)"$/)?.[1] ?? "";
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

	public setIconClass(className: string): void {
		if (this.iconClass === className) return;
		this.iconClass = className;
		this.update_icon();
	}

	private update_icon(): void {
		const iconName = `${this.iconClass || this.className}.svg`;
		const hasIcon = (name: string) =>
			fs.existsSync(path.join(iconDir, "light", name)) || fs.existsSync(path.join(iconDir, "dark", name));
		if (!hasIcon(iconName)) {
			if (!this.iconClass && !hasIcon(`${this.className}.svg`)) {
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

/** Everything the parser knows when it creates a scene. */
export interface SceneInit {
	path: string;
	title: string;
	mtime: number;
	/** Raw text of the scene file, used to compute property edits. */
	source: string;
	/** Hash of `source`, used to detect an unchanged file. */
	fingerprint: string;
}

export class Scene {
	public readonly path: string;
	public readonly title: string;
	public readonly mtime: number;
	public readonly source: string;
	public readonly sourceFingerprint: string;
	public root: SceneNode | undefined;
	public externalResources = new Map<string, GDResource>();
	public subResources = new Map<string, GDResource>();
	public nodes = new Map<string, SceneNode>();

	constructor(init: SceneInit) {
		this.path = init.path;
		this.title = init.title;
		this.mtime = init.mtime;
		this.source = init.source;
		this.sourceFingerprint = init.fingerprint;
	}
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
