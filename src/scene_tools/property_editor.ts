/**
 * Property editing for the Scene Preview.
 *
 * The Scene Preview writes node properties back into the `.tscn` text document
 * through `WorkspaceEdit`, so the file on disk stays the single source of truth
 * and `Open With... > Text Editor` keeps working. Type information comes from
 * the same sources as the Resource Inspector: the connected Godot language
 * server, the node's script `@export` annotations, and the value already stored
 * in the file.
 */

import * as vscode from "vscode";
import type { LspClientLike } from "../lsp/types";
import {
	PropertyMetadata,
	collectPropertyMetadata,
	enumOptions,
	parseScriptExports,
	widgetForProperty,
} from "../resource_inspector/metadata.js";
import type { ResourceDocument } from "../resource_inspector/document.js";
import { parseVariant, type VariantValue } from "../resource_inspector/values.js";
import { convert_resource_path_to_uri, createLogger } from "../utils/index.js";
import { createLruCache } from "../utils/lru_cache.js";
import { withTimeout } from "../utils/scheduling.js";
import { findProperty, planPropertyWrite } from "./properties.js";
import type { Scene, SceneNode, SceneResource } from "./types.js";

const log = createLogger("scenes.properties");

const LSP_METADATA_TIMEOUT_MS = 4_000;

export interface NodePropertyOptions {
	lspClient?: () => LspClientLike | undefined;
	lspTimeoutMs?: number;
}

/**
 * Native property metadata per class, plus the `@export` properties of the
 * script that node runs. The cache is bounded because a project can reference
 * arbitrarily many classes over a session.
 */
export class NodePropertyMetadata {
	private readonly nativeCache = createLruCache<string, Promise<PropertyMetadata[]>>({ capacity: 64 });

	constructor(private readonly options: NodePropertyOptions = {}) {}

	async forNode(scene: Scene, node: SceneNode): Promise<PropertyMetadata[]> {
		const properties = new Map<string, PropertyMetadata>();
		for (const property of await this.nativeProperties(node.className)) properties.set(property.name, property);

		const scriptUri = await this.scriptUri(scene, node);
		if (scriptUri) {
			try {
				const source = await vscode.workspace.fs.readFile(scriptUri);
				for (const property of parseScriptExports(Buffer.from(source).toString("utf8"))) {
					const existing = properties.get(property.name);
					properties.set(
						property.name,
						existing ? { ...property, ...existing, name: property.name } : property,
					);
				}
			} catch (error) {
				log.debug(`Unable to read script '${scriptUri.fsPath}': ${String(error)}`);
			}
		}

		// Values already in the file still need a type so they can be validated.
		for (const property of node.properties) {
			if (properties.has(property.name)) continue;
			const parsed = parseVariant(property.raw);
			properties.set(property.name, {
				name: property.name,
				type: inferredPropertyType(scene, parsed.value),
				source: "file",
			});
		}
		return [...properties.values()];
	}

	/** Native and built-in resource properties for embedded scene resources. */
	async forClass(className: string): Promise<PropertyMetadata[]> {
		const native = await this.nativeProperties(className);
		const document: ResourceDocument = {
			text: "",
			lineEnding: "\n",
			resourceType: className,
			headerLine: 0,
			extResources: [],
			subResources: [],
			properties: [],
		};
		return collectPropertyMetadata({
			document,
			lspProperties: native.map((property) => ({
				name: property.name,
				type: property.type,
				hint: property.hint,
				hint_string: property.hintString,
				default_value: property.defaultValue,
			})),
		});
	}

	/** Metadata of a single property, or `undefined` when nothing is known. */
	async forProperty(scene: Scene, node: SceneNode, name: string): Promise<PropertyMetadata | undefined> {
		return (await this.forNode(scene, node)).find((property) => property.name === name);
	}

	private async scriptUri(scene: Scene, node: SceneNode): Promise<vscode.Uri | undefined> {
		for (const id of [node.scriptId, node.customTypeScriptId].filter(Boolean)) {
			const resource = scene.externalResources.get(id);
			if (!resource?.path?.endsWith(".gd")) continue;
			if (resource.path.startsWith("res://")) {
				try {
					return await convert_resource_path_to_uri(resource.path);
				} catch (error) {
					log.debug(`Unable to resolve '${resource.path}': ${String(error)}`);
					return undefined;
				}
			}
			return vscode.Uri.file(resource.path);
		}
		return undefined;
	}

	private async nativeProperties(className: string): Promise<PropertyMetadata[]> {
		if (!className || className === "Node" || className.startsWith("res://")) return [];
		const cached = this.nativeCache.get(className);
		if (cached) return cached;
		const client = this.options.lspClient?.();
		if (!client?.sendRequest) return [];
		const request = (async (): Promise<PropertyMetadata[]> => {
			try {
				const symbol = (await withTimeout(
					client.sendRequest("textDocument/nativeSymbol", {
						native_class: className,
						symbol_name: className,
					}),
					this.options.lspTimeoutMs ?? LSP_METADATA_TIMEOUT_MS,
				)) as
					| {
							children?: Array<{
								name?: string;
								detail?: string;
								kind?: number;
								hint?: string;
								hint_string?: string;
							}>;
					  }
					| undefined;
				const properties: PropertyMetadata[] = [];
				for (const child of symbol?.children ?? []) {
					if (!child.name) continue;
					const detail = child.detail ?? "";
					if (!/\bvar\s/.test(detail)) continue;
					const type = detail.match(/\bvar\s+[\w.]+\s*:\s*([^=]+?)(?:\s*=|$)/)?.[1]?.trim() ?? "Variant";
					const rawDefault = detail.match(/\s=\s*([\s\S]+)$/)?.[1]?.trim();
					properties.push({
						name: child.name,
						type,
						hint: child.hint,
						hintString: child.hint_string,
						...(rawDefault && !parseVariant(rawDefault).error ? { defaultValue: rawDefault } : {}),
						source: "lsp",
					});
				}
				if (!properties.length) this.nativeCache.delete(className);
				return properties;
			} catch (error) {
				this.nativeCache.delete(className);
				log.debug(`No native metadata for '${className}': ${String(error)}`);
				return [];
			}
		})();
		this.nativeCache.set(className, request);
		return request;
	}

	clear(): void {
		this.nativeCache.clear();
	}
}

function resourceTypeForReference(
	scene: Scene,
	kind: "ExtResource" | "SubResource",
	id: string | undefined,
): string | undefined {
	if (!id) return undefined;
	return kind === "ExtResource" ? scene.externalResources.get(id)?.type : scene.subResources.get(id)?.type;
}

function inferredPropertyType(scene: Scene, value: VariantValue): string {
	const resourceType =
		value.kind === "ExtResource" || value.kind === "SubResource"
			? (resourceTypeForReference(scene, value.kind, value.referenceId) ?? "Resource")
			: undefined;
	const arrayType = value.kind === "Array" ? inferredResourceArrayType(scene, value) : undefined;
	return resourceType ?? arrayType ?? value.kind;
}

function inferredResourceArrayType(scene: Scene, value: VariantValue): string | undefined {
	if (value.arrayType) return `Array[${value.arrayType}]`;
	const itemTypes = (value.items ?? []).flatMap((item) =>
		item.kind === "ExtResource" || item.kind === "SubResource"
			? [resourceTypeForReference(scene, item.kind, item.referenceId)].filter((itemType): itemType is string =>
					Boolean(itemType),
				)
			: [],
	);
	const firstType = itemTypes[0];
	const type = firstType && itemTypes.every((itemType) => itemType === firstType) ? firstType : "Resource";
	return itemTypes.length ? `Array[${type}]` : undefined;
}

/** Prompts for a new value of `name`, validating it against the property type. */
export async function promptPropertyValue(
	metadata: PropertyMetadata | undefined,
	current: string,
): Promise<string | undefined | null> {
	const parsed = parseVariant(current);
	const widget = widgetForProperty(metadata, parsed.value);

	if (widget.kind === "checkbox")
		return await vscode.window.showQuickPick(["true", "false"], { title: metadata?.name });
	if (widget.kind === "enum" && widget.options?.length) {
		// Enum options are stored as their index, except for String-backed enums
		// where the name itself is the value.
		const items = widget.options.map((label, index) => ({
			label,
			description: widget.elementType === "String" ? label : String(index),
		}));
		const picked = await vscode.window.showQuickPick(items, { title: metadata?.name });
		return picked?.description;
	}

	const input = await vscode.window.showInputBox({
		title: metadata?.name,
		value: current,
		valueSelection: [0, current.length],
		placeHolder: metadata?.type ?? parsed.value.kind,
		validateInput: (value) => {
			const result = parseVariant(value);
			if (result.error) return result.error;
			if (result.value.kind === "Variant" && value.trim().length === 0) return "A value is required.";
			return undefined;
		},
	});
	return input;
}

/**
 * Applies a property write to the scene document.
 *
 * `value === null` removes the override from the scene, which is how Godot's own
 * inspector behaves: the node falls back to the value its class defines.
 */
export async function applyScenePropertyWrite(
	document: vscode.TextDocument,
	scene: Scene,
	node: SceneNode,
	name: string,
	value: string | null,
): Promise<boolean> {
	if (node.position < 0 || node.bodyEnd < 0) return false;
	const section = {
		headerStart: node.position,
		headerEnd: node.position + node.text.length,
		bodyEnd: node.bodyEnd,
		properties: node.properties,
	};
	const plan = planPropertyWrite(scene.source, section, name, value);
	if (!plan) return false;

	const edit = new vscode.WorkspaceEdit();
	edit.replace(
		document.uri,
		new vscode.Range(document.positionAt(plan.start), document.positionAt(plan.end)),
		plan.newText,
	);
	return vscode.workspace.applyEdit(edit);
}

/** Applies an embedded-resource override to its `[sub_resource]` body. */
export async function applySceneResourcePropertyWrite(
	document: vscode.TextDocument,
	scene: Scene,
	resource: SceneResource,
	name: string,
	value: string | null,
): Promise<boolean> {
	if (resource.index < 0 || resource.bodyEnd < 0) return false;
	const headerLineEnd = scene.source.indexOf("\n", resource.index);
	const headerEnd =
		headerLineEnd < 0 ? scene.source.length : headerLineEnd - (scene.source[headerLineEnd - 1] === "\r" ? 1 : 0);
	const section = {
		headerStart: resource.index,
		headerEnd,
		bodyEnd: resource.bodyEnd,
		properties: resource.properties,
	};
	const plan = planPropertyWrite(scene.source, section, name, value);
	if (!plan) return false;

	const edit = new vscode.WorkspaceEdit();
	edit.replace(
		document.uri,
		new vscode.Range(document.positionAt(plan.start), document.positionAt(plan.end)),
		plan.newText,
	);
	return vscode.workspace.applyEdit(edit);
}

/**
 * Properties that can be added to a node: every known property that the scene
 * does not override yet, most relevant (script) first.
 */
export function addableProperties(metadata: readonly PropertyMetadata[], node: SceneNode): PropertyMetadata[] {
	return metadata
		.filter((property) => property.name !== "script" && !findProperty(node.properties, property.name))
		.sort((left, right) => {
			const leftDefault = left.defaultValue !== undefined ? 0 : 1;
			const rightDefault = right.defaultValue !== undefined ? 0 : 1;
			if (leftDefault !== rightDefault) return leftDefault - rightDefault;
			if (left.source !== right.source) return left.source === "script" ? -1 : right.source === "script" ? 1 : 0;
			return left.name.localeCompare(right.name);
		});
}

/** Enum options of a property, used when the tree renders the current value. */
export function propertyEnumLabels(metadata: PropertyMetadata | undefined): string[] | undefined {
	return metadata?.hint === "enum" ? enumOptions(metadata.hintString) : undefined;
}
