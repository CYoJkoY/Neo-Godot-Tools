import * as path from "node:path";
import * as vscode from "vscode";
import {
	CancellationToken,
	DataTransfer,
	DocumentDropEdit,
	DocumentDropEditProvider,
	ExtensionContext,
	languages,
	Position,
	TextDocument,
} from "vscode";
import { SceneParser } from "../scene_tools/parser";
import { node_name_to_snake, get_project_version, convert_uri_to_resource_path } from "../utils";
import { SceneNode } from "../scene_tools/types";

function read_boolean(value: unknown): boolean {
	if (typeof value === "boolean") return value;
	if (typeof value !== "string") return false;
	return value.trim().toLowerCase() === "true";
}

export class GDDocumentDropEditProvider implements DocumentDropEditProvider {
	public parser = new SceneParser();

	constructor(private context: ExtensionContext) {
		const dropEditSelector = [
			{ language: "csharp", scheme: "file" },
			{ language: "gdscript", scheme: "file" },
		];
		context.subscriptions.push(languages.registerDocumentDropEditProvider(dropEditSelector, this));
	}

	public async provideDocumentDropEdits(
		document: TextDocument,
		position: Position,
		dataTransfer: DataTransfer,
		token: CancellationToken,
	): Promise<DocumentDropEdit | undefined> {
		const targetResPath = await convert_uri_to_resource_path(document.uri);

		const dataValue = dataTransfer.get("godot/scene")?.value;
		if (!dataValue) return undefined;

		const originFsPath = dataValue;
		const originUri = vscode.Uri.file(originFsPath);
		const originDocument = await vscode.workspace.openTextDocument(originUri);
		const scene = this.parser.parse_scene(originDocument);
		if (!scene || !scene.root) return undefined;

		let scriptId = "";
		for (const res of scene.externalResources.values()) {
			if (res.path === targetResPath) {
				scriptId = res.id;
				break;
			}
		}

		let nodePathOfTarget: SceneNode | undefined;
		if (scriptId) {
			if (scene.root.scriptId === scriptId) {
				nodePathOfTarget = scene.root;
			} else {
				for (const node of scene.nodes.values()) {
					if (node.scriptId === scriptId) {
						nodePathOfTarget = node;
						break;
					}
				}
			}
		}

		const className: string | undefined = dataTransfer.get("godot/class")?.value;
		if (!className) return undefined;

		const nodePath: string = dataTransfer.get("godot/path")?.value ?? "";
		let relativePath: string = dataTransfer.get("godot/relativePath")?.value ?? "";
		const unique = read_boolean(dataTransfer.get("godot/unique")?.value);
		const label: string = dataTransfer.get("godot/label")?.value ?? "";

		if (nodePathOfTarget && nodePath) {
			const targetPath = path.normalize(path.relative(nodePathOfTarget.path, nodePath));
			relativePath = targetPath.split(path.sep).join(path.posix.sep);
		}

		const savePath = relativePath || label;

		if (document.languageId === "gdscript") {
			// GDScript's node-path syntax is always a quoted string. A unique node
			// is represented as $"%NodeName"; ordinary nodes use $"NodePath".
			const escapedPath = (unique ? `%${label}` : savePath).replace(/\\/g, "\\\\").replace(/"/g, '\\"');
			const qualifiedPath = `$"${escapedPath}"`;

			const line = document.lineAt(position.line);
			if (line.text === "") {
				const snippet = new vscode.SnippetString();

				const projectVersion = await get_project_version() ?? "";
				if (projectVersion.startsWith("4")) snippet.appendText("@");
				snippet.appendText("onready var ");
				snippet.appendPlaceholder(node_name_to_snake(label));
				snippet.appendText(`: ${className} = ${qualifiedPath}`);
				return new vscode.DocumentDropEdit(snippet);
			}

			return new vscode.DocumentDropEdit(qualifiedPath);
		}

		if (document.languageId === "csharp") {
			return new vscode.DocumentDropEdit(`GetNode<${className}>("${savePath}")`);
		}
		return undefined;
	}
}
