/**
 * Text-preserving resource edits for `.tscn` scenes.
 *
 * Scene files store external resources before embedded sub-resources and nodes,
 * so their insertions are intentionally separate from the `.tres` editor's
 * `[gd_resource]` helpers. Property value edits continue to use the node/resource
 * offsets supplied by the Scene parser.
 */

import { extname } from "node:path";
import { resourceReference, uniqueExtResourceId, uniqueSubResourceId } from "../resource_inspector/document.js";

export interface SceneResourceHeader {
	id: string;
	type: string;
	path?: string;
	kind: "ext_resource" | "sub_resource";
	line: number;
}

export interface SceneResourceAddition {
	text: string;
	id: string;
	changed: boolean;
}

interface SceneArrayForm {
	name: string;
	wrapped: boolean;
	items: string[];
}

interface SplitState {
	parts: string[];
	depth: number;
	quoted: string | undefined;
	escaped: boolean;
	start: number;
}

const SECTION_RE = /^\s*\[(gd_scene|ext_resource|sub_resource|node|connection|editable)\b[^\]]*\]/;

function lineEndingOf(text: string): string {
	return text.includes("\r\n") ? "\r\n" : "\n";
}

function quotedAttribute(header: string, name: string): string | undefined {
	const match = header.match(
		new RegExp(`\\b${name}\\s*=\\s*(?:"((?:\\\\.|[^"])*)"|'((?:\\\\.|[^'])*)'|([^\\s\\]]+))`),
	);
	const raw = match?.[1] ?? match?.[2] ?? match?.[3];
	return raw === undefined ? undefined : raw.replace(/\\([\\"'])/g, "$1");
}

export function sceneFormat(text: string): string | undefined {
	const header = text.match(/^\s*\[gd_scene\b[^\]]*\]/m)?.[0];
	return header?.match(/\bformat\s*=\s*(\d+)/)?.[1];
}

export function sceneResourceHeaders(text: string): SceneResourceHeader[] {
	return text.split(/\r?\n/).flatMap((value, line) => {
		const header = value.match(/^\s*\[(ext_resource|sub_resource)\b[^\]]*\]/)?.[0];
		const id = header ? quotedAttribute(header, "id") : undefined;
		return !header || !id
			? []
			: [
					{
						id,
						type: quotedAttribute(header, "type") ?? "Resource",
						path: quotedAttribute(header, "path"),
						kind: header.includes("[ext_resource") ? "ext_resource" : "sub_resource",
						line,
					},
				];
	});
}

export function uniqueSceneSubResourceId(text: string, type: string): string {
	const existing = sceneResourceHeaders(text)
		.filter((entry) => entry.kind === "sub_resource")
		.map((entry) => entry.id);
	if (sceneFormat(text) === "2") {
		const largest = existing
			.filter((id) => /^\d+$/.test(id))
			.map(BigInt)
			.reduce((maximum, value) => (value > maximum ? value : maximum), 0n);
		return String(largest + 1n);
	}
	return uniqueSubResourceId(type, existing);
}

export function sceneResourceReference(kind: "Ext" | "Sub", id: string, text: string): string {
	return resourceReference(kind, id, sceneFormat(text));
}

/** Returns the existing ID for a path, otherwise the next safe external ID. */
export function sceneExternalResourceId(text: string, resourcePath: string): string | undefined {
	return sceneResourceHeaders(text)
		.filter((entry) => entry.kind === "ext_resource")
		.find((resource) => resource.path === resourcePath)?.id;
}

function insertionIndex(lines: string[], kind: "ext_resource" | "sub_resource"): number {
	const sectionLines = lines.flatMap((line, index) => {
		const match = line.match(SECTION_RE);
		return match ? [{ index, kind: match[1] }] : [];
	});
	const lastExtIndex = sectionLines.filter((section) => section.kind === "ext_resource").at(-1)?.index;
	const sceneIndex = sectionLines.find((section) => section.kind === "gd_scene")?.index;
	const firstNodeIndex = sectionLines.find((section) =>
		["node", "connection", "editable"].includes(section.kind),
	)?.index;
	return kind === "ext_resource"
		? lastExtIndex !== undefined
			? lastExtIndex + 1
			: sceneIndex !== undefined
				? sceneIndex + 1
				: lines.length
		: (firstNodeIndex ?? lines.length);
}

function insertSection(
	lines: string[],
	index: number,
	kind: "ext_resource" | "sub_resource",
	block: string[],
): string[] {
	const previous = lines[index - 1]?.trim() ?? "";
	const next = lines[index]?.trim() ?? "";
	const previousIsExtResource = /^\[ext_resource\b/.test(previous);
	const leading = previous.length > 0 && !(kind === "ext_resource" && previousIsExtResource) ? [""] : [];
	const trailing = index < lines.length && next.length > 0 ? [""] : [];
	return [...lines.slice(0, index), ...leading, ...block, ...trailing, ...lines.slice(index)];
}

function updateLoadSteps(text: string): string {
	const lineEnding = lineEndingOf(text);
	const lines = text.split(/\r?\n/);
	const headerLine = lines.findIndex((line) => /^\s*\[gd_scene\b/.test(line));
	if (headerLine < 0) return text;
	const count = sceneResourceHeaders(text).length + 1;
	const header = lines[headerLine];
	const updatedHeader = /\bload_steps\s*=\s*\d+/.test(header)
		? header.replace(/\bload_steps\s*=\s*\d+/, `load_steps=${count}`)
		: count > 1
			? header.replace(/\]$/, ` load_steps=${count}]`)
			: header;
	return lines.map((line, index) => (index === headerLine ? updatedHeader : line)).join(lineEnding);
}

export function addSceneExternalResource(
	text: string,
	resource: { type: string; path: string; uid?: string; id?: string },
): SceneResourceAddition {
	const existingId = sceneExternalResourceId(text, resource.path);
	if (existingId) return { text, id: existingId, changed: false };
	const headerLine = text.match(/^\s*\[gd_scene\b[^\]]*\]/m)?.[0];
	if (!headerLine) return { text, id: "", changed: false };

	const resources = sceneResourceHeaders(text).filter((entry) => entry.kind === "ext_resource");
	const format = sceneFormat(text);
	const id =
		resource.id ??
		uniqueExtResourceId(
			resources.map((entry) => entry.id),
			format,
		);
	if (resources.some((entry) => entry.id === id)) return { text, id: "", changed: false };
	const attributes = [
		`type=${JSON.stringify(resource.type)}`,
		...(resource.uid ? [`uid=${JSON.stringify(resource.uid)}`] : []),
		`path=${JSON.stringify(resource.path)}`,
		`id=${format === "2" ? id : JSON.stringify(id)}`,
	];
	const lines = insertSection(
		text.split(/\r?\n/),
		insertionIndex(text.split(/\r?\n/), "ext_resource"),
		"ext_resource",
		[`[ext_resource ${attributes.join(" ")}]`],
	);
	return { text: updateLoadSteps(lines.join(lineEndingOf(text))), id, changed: true };
}

export function addSceneSubResource(
	text: string,
	resource: { type: string; id?: string; properties?: Record<string, string> },
): SceneResourceAddition {
	const headerLine = text.match(/^\s*\[gd_scene\b[^\]]*\]/m)?.[0];
	if (!headerLine) return { text, id: "", changed: false };
	const id = resource.id ?? uniqueSceneSubResourceId(text, resource.type);
	const resources = sceneResourceHeaders(text).filter((entry) => entry.kind === "sub_resource");
	if (resources.some((entry) => entry.id === id)) return { text, id: "", changed: false };
	const idText = sceneFormat(text) === "2" ? id : JSON.stringify(id);
	const block = [
		`[sub_resource type=${JSON.stringify(resource.type)} id=${idText}]`,
		...Object.entries(resource.properties ?? {}).map(([name, value]) => `${name} = ${value}`),
	];
	const sourceLines = text.split(/\r?\n/);
	const lines = insertSection(sourceLines, insertionIndex(sourceLines, "sub_resource"), "sub_resource", block);
	return { text: updateLoadSteps(lines.join(lineEndingOf(text))), id, changed: true };
}

function splitTopLevel(text: string): string[] {
	const initial: SplitState = { parts: [], depth: 0, quoted: undefined, escaped: false, start: 0 };
	const result = text.split("").reduce((state, char, index): SplitState => {
		if (state.quoted) {
			const quoted = state.quoted;
			const closingQuote = char === quoted && !state.escaped;
			state.escaped = char === "\\" && !state.escaped;
			if (closingQuote) state.quoted = undefined;
			return state;
		}
		if (char === '"' || char === "'") {
			state.quoted = char;
			return state;
		}
		const depth = state.depth + Number("([{".includes(char)) - Number(")]}".includes(char));
		if (char === "," && depth === 0) {
			state.parts.push(text.slice(state.start, index).trim());
			state.start = index + 1;
			return state;
		}
		state.depth = depth;
		return state;
	}, initial);
	const last = text.slice(result.start).trim();
	return last ? [...result.parts, last] : result.parts;
}

function parseSceneArray(raw: string): SceneArrayForm | undefined {
	const text = raw.trim();
	const match = text.match(/^([A-Za-z_][A-Za-z0-9_]*(?:\[[^\]]*\])?)\(([\s\S]*)\)$/);
	if (match) {
		const body = match[2].trim();
		const wrapped = body.startsWith("[") && body.endsWith("]");
		const content = wrapped ? body.slice(1, -1) : body;
		return { name: match[1], wrapped, items: splitTopLevel(content) };
	}
	return text.startsWith("[") && text.endsWith("]")
		? { name: "", wrapped: true, items: splitTopLevel(text.slice(1, -1)) }
		: undefined;
}

function serializeSceneArray(form: SceneArrayForm): string {
	const body = form.items.join(", ");
	if (!form.name) return `[${body}]`;
	const content = form.wrapped || form.name === "Array" ? `[${body}]` : body;
	return `${form.name}(${content})`;
}

/** Changes one list member while preserving the original typed/packed container. */
export function replaceSceneArrayItem(raw: string, index: number, value: string): string | undefined {
	const form = parseSceneArray(raw);
	if (!form || index < 0 || index >= form.items.length) return undefined;
	form.items[index] = value;
	return serializeSceneArray(form);
}

/** Godot resource type inferred from a selected file, with property metadata as fallback. */
export function sceneExternalResourceType(
	filePath: string,
	format: string | undefined,
	resourceSource?: string,
	fallback = "Resource",
): string {
	const extension = extname(filePath).toLowerCase();
	switch (extension) {
		case ".gd":
			return "Script";
		case ".gdshader":
			return "Shader";
		case ".tscn":
			return "PackedScene";
		case ".tres":
			return resourceSource?.match(/^\s*\[gd_resource\b[^\]]*\btype\s*=\s*["']([^"']+)["']/m)?.[1] ?? fallback;
		case ".png":
		case ".svg":
		case ".jpg":
		case ".jpeg":
		case ".gif":
		case ".bmp":
		case ".webp":
			return format === "2" ? "Texture" : "Texture2D";
		default:
			return fallback;
	}
}
