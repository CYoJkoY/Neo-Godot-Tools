/**
 * Parsing and text-preserving editing of Godot `.tres` resource files.
 *
 * The inspector keeps the file as the source of truth: every edit rewrites only
 * the affected lines, so the `[gd_resource ...]` header, the property order and
 * comments elsewhere in the file survive untouched.
 */

import { LruCache } from "../utils/lru_cache.js";
import { VariantValue, parseVariant } from "./values.js";

/** Attributes a `[...]` section header may carry. */
export interface SectionAttributes {
	id?: string;
	type?: string;
	path?: string;
	uid?: string;
	format?: string;
	load_steps?: string;
	script_class?: string;
}

const SECTION_ATTRIBUTE_NAMES = new Set<keyof SectionAttributes>([
	"id",
	"type",
	"path",
	"uid",
	"format",
	"load_steps",
	"script_class",
]);

function is_section_attribute(name: string): name is keyof SectionAttributes {
	return SECTION_ATTRIBUTE_NAMES.has(name as keyof SectionAttributes);
}

export interface PropertyEntry {
	name: string;
	valueText: string;
	line: number;
	/** Inclusive last line of a multi-line value. */
	endLine: number;
	value: VariantValue;
}

export interface ExtResourceEntry {
	id: string;
	type: string;
	path?: string;
	uid?: string;
	line: number;
	endLine: number;
}

export interface SubResourceEntry {
	id: string;
	type: string;
	line: number;
	endLine: number;
	properties: PropertyEntry[];
}

export interface ResourceDocument {
	text: string;
	lineEnding: string;
	resourceType: string;
	scriptClass?: string;
	format?: string;
	uid?: string;
	loadSteps?: string;
	headerLine: number;
	extResources: ExtResourceEntry[];
	subResources: SubResourceEntry[];
	properties: PropertyEntry[];
}

const SECTION_RE = /^\[([a-z_]+)\s*(.*)\]$/;
const ATTRIBUTE_RE = /([A-Za-z_][A-Za-z0-9_]*)\s*=\s*("(?:[^"\\]|\\.)*"|'(?:[^'\\]|\\.)*'|[^\s\]]+)/g;

function unquote(value: string | undefined): string | undefined {
	if (!value) return undefined;
	if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
		return value.slice(1, -1).replace(/\\(.)/g, "$1");
	}
	return value;
}

function parseAttributes(text: string): SectionAttributes {
	const attributes: SectionAttributes = {};
	for (const match of text.matchAll(ATTRIBUTE_RE)) {
		const name = match[1];
		if (!is_section_attribute(name)) continue;
		attributes[name] = unquote(match[2]) ?? match[2];
	}
	return attributes;
}

/** Returns the last line of an assignment whose value spans multiple lines. */
function assignmentEndLine(lines: string[], start: number): number {
	let depth = 0;
	let quoted: string | undefined;
	for (let line = start; line < lines.length; line++) {
		const text = line === start ? lines[line].slice(lines[line].indexOf("=") + 1) : lines[line];
		for (let index = 0; index < text.length; index++) {
			const char = text[index];
			if (quoted) {
				if (char === "\\") index++;
				else if (char === quoted) quoted = undefined;
				continue;
			}
			if (char === '"' || char === "'") {
				quoted = char;
				continue;
			}
			if (char === "(" || char === "[" || char === "{") depth++;
			else if (char === ")" || char === "]" || char === "}") depth--;
		}
		if (depth <= 0 && !quoted) return line;
	}
	return lines.length - 1;
}

/**
 * Property names are plain identifiers, except for theme-style keys
 * (`Button/colors/font_color`) which also contain `/` and `.`.
 */
const PROPERTY_RE = /^([A-Za-z_][A-Za-z0-9_/.]*)\s*=\s*(.*)$/;

function parseProperties(lines: string[], start: number, end: number): PropertyEntry[] {
	const properties: PropertyEntry[] = [];
	for (let line = start; line < end; line++) {
		const match = lines[line].match(PROPERTY_RE);
		if (!match) continue;
		const endLine = assignmentEndLine(lines, line);
		const valueText = lines
			.slice(line, endLine + 1)
			.map((text, index) => (index === 0 ? text.slice(text.indexOf("=") + 1) : text))
			.join("\n")
			.trim();
		properties.push({ name: match[1], valueText, line, endLine, value: parseVariant(valueText).value });
		line = endLine;
	}
	return properties;
}

function findSectionEnd(lines: string[], start: number): number {
	let line = start;
	let quoted: string | undefined;
	while (line < lines.length) {
		const text = lines[line];
		if (!quoted && SECTION_RE.test(text.trim())) break;
		for (let index = 0; index < text.length; index++) {
			const char = text[index];
			if (quoted) {
				if (char === "\\") index++;
				else if (char === quoted) quoted = undefined;
				continue;
			}
			if (char === ";") break;
			if (char === '"' || char === "'") quoted = char;
		}
		line++;
	}
	// Trailing blank lines belong to the file, not to the section.
	while (line > start && lines[line - 1].trim() === "") line--;
	return line;
}

export function parseResourceDocument(text: string): ResourceDocument {
	const lineEnding = text.includes("\r\n") ? "\r\n" : "\n";
	const lines = text.split(/\r?\n/);
	const document: ResourceDocument = {
		text,
		lineEnding,
		resourceType: "Resource",
		headerLine: -1,
		extResources: [],
		subResources: [],
		properties: [],
	};

	for (let line = 0; line < lines.length; line++) {
		const trimmed = lines[line].trim();
		const section = trimmed.match(SECTION_RE);
		if (!section) continue;
		const name = section[1];
		const attributes = parseAttributes(section[2]);
		const end = findSectionEnd(lines, line + 1);
		if (name === "gd_resource") {
			document.headerLine = line;
			document.resourceType = attributes.type ?? "Resource";
			document.scriptClass = attributes.script_class;
			document.format = attributes.format;
			document.uid = attributes.uid;
			document.loadSteps = attributes.load_steps;
		} else if (name === "ext_resource") {
			document.extResources.push({
				id: attributes.id ?? "",
				type: attributes.type ?? "Resource",
				path: attributes.path,
				uid: attributes.uid,
				line,
				endLine: end - 1,
			});
		} else if (name === "sub_resource") {
			document.subResources.push({
				id: attributes.id ?? "",
				type: attributes.type ?? "Resource",
				line,
				endLine: end - 1,
				properties: parseProperties(lines, line + 1, end),
			});
		} else if (name === "resource") {
			document.properties = parseProperties(lines, line + 1, end);
		}
		line = end - 1;
	}
	return document;
}

/**
 * Parse cache for open resource documents.
 *
 * Every edit, image preview and diagnostics pass re-parsed the whole file; the
 * key is the `TextDocument.version`, so a changed document is parsed once and
 * an unchanged one is served from memory.
 */
export interface DocumentParseCache {
	/** Parses `text` unless the cached entry is already for `version`. */
	parse(uri: string, version: number, text: () => string): ResourceDocument;
	invalidate(uri: string): void;
	readonly size: number;
}

export function createDocumentParseCache(capacity = 64): DocumentParseCache {
	const entries = new LruCache<string, { version: number; parsed: ResourceDocument }>({ capacity });
	return {
		parse(uri, version, text) {
			const cached = entries.get(uri);
			if (cached?.version === version) return cached.parsed;
			const parsed = parseResourceDocument(text());
			entries.set(uri, { version, parsed });
			return parsed;
		},
		invalidate(uri) {
			entries.delete(uri);
		},
		get size() {
			return entries.size;
		},
	};
}

export type ResourceEdit =
	| { kind: "setProperty"; name: string; value: string; target?: string }
	| { kind: "revertProperty"; name: string; defaultValue?: string; target?: string }
	| { kind: "addExtResource"; type: string; path: string; uid?: string }
	| { kind: "deleteExtResource"; id: string }
	| { kind: "addSubResource"; type: string; properties?: Record<string, string> }
	| { kind: "duplicateSubResource"; id: string }
	| { kind: "renameSubResource"; id: string; newId: string }
	| { kind: "deleteSubResource"; id: string };

export interface EditResult {
	text: string;
	/** IDs created by adding or duplicating external/internal resources. */
	createdIds: string[];
}

/** Generates the next free `Type_N` sub-resource id. */
export function uniqueSubResourceId(type: string, existing: readonly string[]): string {
	const base = `${type || "Resource"}`;
	let index = 1;
	while (existing.includes(`${base}_${index}`)) index++;
	return `${base}_${index}`;
}

/**
 * Continues the numeric sequence, rather than filling a hole or restarting at
 * 1 when a Godot 3 file uses bare numeric IDs. Existing IDs are never renamed.
 */
export function uniqueExtResourceId(existing: readonly string[], format?: string): string {
	let largest = 0n;
	for (const id of existing) {
		const prefix = id.match(/^(\d+)(?:_|$)/)?.[1];
		if (prefix !== undefined && BigInt(prefix) > largest) largest = BigInt(prefix);
	}
	const next = String(largest + 1n);
	const numericStyle = format === "2" || (existing.length > 0 && existing.every((id) => /^\d+$/.test(id)));
	return numericStyle ? next : `${next}_res`;
}

/** Godot 3 references use unquoted numeric IDs; Godot 4 uses strings. */
export function resourceReference(kind: "Ext" | "Sub", id: string, format?: string): string {
	return format === "2" && /^\d+$/.test(id) ? `${kind}Resource( ${id} )` : `${kind}Resource(${JSON.stringify(id)})`;
}

function indentOf(line: string): string {
	return line.match(/^\s*/)?.[0] ?? "";
}

function insertLine(lines: string[], index: number, text: string): void {
	lines.splice(Math.max(0, Math.min(index, lines.length)), 0, text);
}

/** Inserts a `[sub_resource]` block before the `[resource]` section (or at the end). */
function insertSubResource(lines: string[], type: string, id: string, properties: Record<string, string>): void {
	let target = lines.findIndex((line) => /^\s*\[resource\]/.test(line));
	if (target === -1) target = lines.length;
	const block: string[] = [];
	if (target > 0 && lines[target - 1].trim() !== "") block.push("");
	block.push(`[sub_resource type="${type}" id="${id}"]`);
	for (const [name, value] of Object.entries(properties)) block.push(`${name} = ${value}`);
	if (lines[target] !== undefined && lines[target].trim() !== "") block.push("");
	for (const [offset, text] of block.entries()) insertLine(lines, target + offset, text);
}

function replaceRange(lines: string[], start: number, end: number, replacement: string[]): void {
	lines.splice(start, end - start + 1, ...replacement);
}

/** Replaces every reference to `id`; `replacement===undefined` turns them into `null`. */
function replaceReferences(text: string, id: string, replacement?: string, kind?: "Ext" | "Sub"): string {
	return text.replace(
		/(Ext|Sub)Resource\(\s*(?:"([^"]*)"|(\d+))\s*\)/g,
		(match, prefix: string, quotedId?: string, unquotedId?: string) => {
			const referenceId = quotedId ?? unquotedId;
			if (referenceId !== id || (kind && prefix !== kind)) return match;
			if (replacement === undefined) return "null";
			if (unquotedId !== undefined && /^\d+$/.test(replacement)) {
				return `${prefix}Resource( ${replacement} )`;
			}
			return `${prefix}Resource("${replacement}")`;
		},
	);
}

/** Rewrites every `ExtResource("id")`/`SubResource("id")` reference in `text`. */
export function rewriteReferences(text: string, oldId: string, newId: string): string {
	return replaceReferences(text, oldId, newId);
}

/** Replaces every reference to a removed id with `null`. */
export function dropReferences(text: string, id: string, kind?: "Ext" | "Sub"): string {
	return replaceReferences(text, id, undefined, kind);
}

export function applyResourceEdits(text: string, edits: readonly ResourceEdit[]): EditResult {
	let current = text;
	const createdIds: string[] = [];
	for (const edit of edits) {
		const document = parseResourceDocument(current);
		const lines = current.split(/\r?\n/);
		if (edit.kind === "setProperty" || edit.kind === "revertProperty") {
			// `target` addresses a property of a sub-resource instead of the file's
			// own `[resource]` section.
			const owner = edit.target ? document.subResources.find((entry) => entry.id === edit.target) : undefined;
			if (edit.target && !owner) continue;
			const properties = owner ? owner.properties : document.properties;
			const property = properties.find((entry) => entry.name === edit.name);
			const value = edit.kind === "setProperty" ? edit.value : edit.defaultValue;
			if (property) {
				if (edit.kind === "revertProperty" && value === undefined) {
					// No known default: drop the explicit value so Godot falls back to it.
					replaceRange(lines, property.line, property.endLine, []);
					if (lines[property.line]?.trim() === "" && lines[property.line - 1]?.trim() === "")
						replaceRange(lines, property.line, property.line, []);
				} else {
					replaceRange(lines, property.line, property.endLine, [
						`${indentOf(lines[property.line])}${edit.name} = ${value}`,
					]);
				}
			} else if (value !== undefined) {
				if (owner) {
					const anchor = owner.properties.length
						? owner.properties[owner.properties.length - 1].endLine + 1
						: owner.line + 1;
					insertLine(lines, anchor, `${edit.name} = ${value}`);
				} else {
					let resourceIndex = lines.findIndex((line) => /^\s*\[resource\]/.test(line));
					if (resourceIndex === -1) {
						if (document.headerLine === -1 && lines.every((line) => line.trim() === "")) {
							lines.splice(0, lines.length, '[gd_resource type="Resource" format=3]', "", "[resource]");
							resourceIndex = 2;
						} else {
							if (lines.length && lines[lines.length - 1].trim() !== "") lines.push("");
							lines.push("[resource]");
							resourceIndex = lines.length - 1;
						}
					}
					insertLine(lines, resourceIndex + 1, `${edit.name} = ${value}`);
				}
			}
		} else if (edit.kind === "addSubResource") {
			const id = uniqueSubResourceId(
				edit.type,
				document.subResources.map((entry) => entry.id),
			);
			insertSubResource(lines, edit.type, id, edit.properties ?? {});
			createdIds.push(id);
		} else if (edit.kind === "addExtResource") {
			const id = uniqueExtResourceId(
				document.extResources.map((entry) => entry.id),
				document.format,
			);
			const attributes = [`type=${JSON.stringify(edit.type)}`];
			if (edit.uid) attributes.push(`uid=${JSON.stringify(edit.uid)}`);
			attributes.push(`path=${JSON.stringify(edit.path)}`);
			const target = document.extResources.length
				? document.extResources[document.extResources.length - 1].endLine + 1
				: Math.max(0, document.headerLine + 1);
			const idText = document.format === "2" ? id : JSON.stringify(id);
			const block = ["", `[ext_resource ${attributes.join(" ")} id=${idText}]`];
			if (target >= lines.length || lines[target].trim() !== "") block.push("");
			for (const [offset, text] of block.entries()) insertLine(lines, target + offset, text);
			createdIds.push(id);
		} else if (edit.kind === "deleteExtResource") {
			const source = document.extResources.find((entry) => entry.id === edit.id);
			if (!source) continue;
			replaceRange(lines, source.line, source.endLine, []);
			if (lines[source.line]?.trim() === "" && lines[source.line - 1]?.trim() === "")
				replaceRange(lines, source.line, source.line, []);
			current = dropReferences(lines.join(document.lineEnding), edit.id, "Ext");
			continue;
		} else if (edit.kind === "duplicateSubResource") {
			const source = document.subResources.find((entry) => entry.id === edit.id);
			if (!source) continue;
			const id = uniqueSubResourceId(
				source.type,
				document.subResources.map((entry) => entry.id),
			);
			const body = lines.slice(source.line + 1, source.endLine + 1).join("\n");
			const insert = [`[sub_resource type="${source.type}" id="${id}"]`];
			if (body.trim()) insert.push(body);
			const after = lines[source.endLine + 1];
			if (after === undefined || after.trim() !== "") insert.push("");
			else insert.unshift("");
			for (const [offset, line] of insert.entries()) insertLine(lines, source.endLine + 1 + offset, line);
			createdIds.push(id);
		} else if (edit.kind === "renameSubResource") {
			const source = document.subResources.find((entry) => entry.id === edit.id);
			if (!source) continue;
			replaceRange(lines, source.line, source.line, [`[sub_resource type="${source.type}" id="${edit.newId}"]`]);
			const body = lines.join(document.lineEnding);
			current = rewriteReferences(body, edit.id, edit.newId);
			continue;
		} else if (edit.kind === "deleteSubResource") {
			const source = document.subResources.find((entry) => entry.id === edit.id);
			if (!source) continue;
			replaceRange(lines, source.line, source.endLine, []);
			if (lines[source.line]?.trim() === "" && lines[source.line - 1]?.trim() === "")
				replaceRange(lines, source.line, source.line, []);
			current = dropReferences(lines.join(document.lineEnding), edit.id, "Sub");
			continue;
		}
		current = lines.join(document.lineEnding);
	}
	// Resource additions/removals change the number of load steps too. Do not
	// rewrite the header for ordinary property edits (or ignored commands).
	if (
		current !== text &&
		edits.some((edit) =>
			[
				"addExtResource",
				"deleteExtResource",
				"addSubResource",
				"duplicateSubResource",
				"deleteSubResource",
			].includes(edit.kind),
		)
	) {
		const document = parseResourceDocument(current);
		if (document.headerLine >= 0) {
			const lines = current.split(/\r?\n/);
			const count = document.extResources.length + document.subResources.length + 1;
			const header = lines[document.headerLine];
			if (/\bload_steps\s*=\s*\d+/.test(header)) {
				lines[document.headerLine] = header.replace(/\bload_steps\s*=\s*\d+/, `load_steps=${count}`);
			} else if (count > 1) {
				lines[document.headerLine] = header.replace(/\]$/, ` load_steps=${count}]`);
			}
			current = lines.join(document.lineEnding);
		}
	}
	return { text: current, createdIds };
}

/** Writes back the (edited) document; identical to the input when nothing changed. */
export function serializeResourceDocument(text: string, edits: readonly ResourceEdit[] = []): string {
	return edits.length ? applyResourceEdits(text, edits).text : text;
}
