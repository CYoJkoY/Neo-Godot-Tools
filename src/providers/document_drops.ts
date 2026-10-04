import * as path from "node:path";
import * as vscode from "vscode";
import type {
	CancellationToken,
	DataTransfer,
	DocumentDropEdit,
	DocumentDropEditProvider,
	ExtensionContext,
	Position,
	TextDocument,
} from "vscode";
import { SceneParser } from "../scene_tools/parser";
import type { SceneNode } from "../scene_tools/types";
import { convert_uri_to_resource_path, get_project_version, node_name_to_snake } from "../utils";
import { SCRIPT_SELECTOR } from "./selectors";

/**
 * The drop data of this extension is set by its own scene tree, so the members
 * are narrowed here: `DataTransferItem.value` is untyped in the VS Code API.
 */
function read_string(dataTransfer: DataTransfer, key: string): string {
	const value = dataTransfer.get(key)?.value;
	return typeof value === "string" ? value : "";
}

function read_boolean(dataTransfer: DataTransfer, key: string): boolean {
	const value = dataTransfer.get(key)?.value;
	if (typeof value === "boolean") return value;
	return typeof value === "string" && value.trim().toLowerCase() === "true";
}

/** The node the dropped script is attached to, if the scene has one. */
function scriptOwner(root: SceneNode, scripts: Iterable<SceneNode>, scriptId: string): SceneNode | undefined {
	if (!scriptId) return undefined;
	if (root.scriptId === scriptId) return root;
	return Array.from(scripts).find((node) => node.scriptId === scriptId);
}

/** `$"Node/Path"` for a unique or ordinary node, escaped for GDScript. */
function nodePathExpression(label: string, unique: boolean, savePath: string): string {
	const escaped = (unique ? `%${label}` : savePath).replace(/\\/g, "\\\\").replace(/"/g, '\\"');
	return `$"${escaped}"`;
}

/** The `@onready` variable declaration of an empty line, or the plain path. */
async function gdscriptDrop(
	document: TextDocument,
	position: Position,
	className: string,
	label: string,
	unique: boolean,
	savePath: string,
): Promise<DocumentDropEdit> {
	const expression = nodePathExpression(label, unique, savePath);
	if (document.lineAt(position.line).text !== "") return new vscode.DocumentDropEdit(expression);

	const snippet = new vscode.SnippetString();
	// `@onready` is Godot 4 syntax only.
	if (((await get_project_version()) ?? "").startsWith("4")) snippet.appendText("@");
	snippet.appendText("onready var ");
	snippet.appendPlaceholder(node_name_to_snake(label));
	snippet.appendText(`: ${className} = ${expression}`);
	return new vscode.DocumentDropEdit(snippet);
}

export type GDDocumentDropEditProvider = DocumentDropEditProvider & {
	provideDocumentDropEdits(
		document: TextDocument,
		position: Position,
		dataTransfer: DataTransfer,
		token: CancellationToken,
	): Promise<DocumentDropEdit | undefined>;
};

export function createDocumentDropEditProvider(context: ExtensionContext): GDDocumentDropEditProvider {
	const parser = new SceneParser();
	const provider: GDDocumentDropEditProvider = {
		async provideDocumentDropEdits(
			document: TextDocument,
			position: Position,
			dataTransfer: DataTransfer,
			_token: CancellationToken,
		): Promise<DocumentDropEdit | undefined> {
			const scenePath = read_string(dataTransfer, "godot/scene");
			const className = read_string(dataTransfer, "godot/class");
			if (!scenePath || !className) return undefined;

			const scene = parser.parse_scene(await vscode.workspace.openTextDocument(vscode.Uri.file(scenePath)));
			const root = scene.root;
			if (!root) return undefined;

			const targetResPath = await convert_uri_to_resource_path(document.uri);
			const scriptId =
				Array.from(scene.externalResources.values()).find((resource) => resource.path === targetResPath)?.id ??
				"";
			const owner = scriptOwner(root, scene.nodes.values(), scriptId);

			const nodePath = read_string(dataTransfer, "godot/path");
			const givenPath = read_string(dataTransfer, "godot/relativePath");
			const relativePath =
				owner && nodePath
					? path.normalize(path.relative(owner.path, nodePath)).split(path.sep).join(path.posix.sep)
					: givenPath;
			const label = read_string(dataTransfer, "godot/label");
			const savePath = relativePath || label;

			if (document.languageId === "gdscript")
				return gdscriptDrop(
					document,
					position,
					className,
					label,
					read_boolean(dataTransfer, "godot/unique"),
					savePath,
				);
			if (document.languageId === "csharp")
				return new vscode.DocumentDropEdit(`GetNode<${className}>("${savePath}")`);
			return undefined;
		},
	};
	context.subscriptions.push(vscode.languages.registerDocumentDropEditProvider(SCRIPT_SELECTOR, provider));
	return provider;
}
