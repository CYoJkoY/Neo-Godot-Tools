/**
 * Node properties of a `.tscn` scene.
 *
 * A scene stores only the properties a node overrides; everything else comes
 * from the node's class. The Scene Preview edits those overrides in place, so
 * this module is deliberately a pure text layer: it turns one node section into
 * properties with exact document offsets and back into text edits. Godot's
 * writer keeps one `name = value` per line (values may continue on indented
 * lines), which is what the parser relies on.
 */

export interface SceneProperty {
	name: string;
	/** Value text exactly as written in the file. */
	raw: string;
	/** Offset of the property name. */
	start: number;
	/** Offset right after the value. */
	end: number;
	valueStart: number;
	valueEnd: number;
	/** Resource reference kind when the value is `ExtResource(...)`/`SubResource(...)`. */
	reference?: "ExtResource" | "SubResource";
}

/** Section of a `.tscn` the property helpers work on. */
export interface NodeSection {
	/** Offset of the `[node ...]` header line. */
	headerStart: number;
	/** Offset right after the header line. */
	headerEnd: number;
	/** Offset where the next section starts (or the end of the file). */
	bodyEnd: number;
	properties: SceneProperty[];
}

/** A statement inside a node section, as written in the file. */
const PROPERTY_LINE = /^([A-Za-z_][A-Za-z0-9_/.]*)\s*=\s*([\s\S]*)$/;
const PROPERTY_LINE_START = /^[A-Za-z_][A-Za-z0-9_/.]*\s*=/;

/**
 * Parses the overridden properties of a node section.
 *
 * `start` is the offset of the `[node ...]` header and `end` the offset of the
 * next section, so every returned offset can be used in a VS Code edit without
 * translating line/column pairs.
 */
export function parseNodeProperties(text: string, start: number, end: number): SceneProperty[] {
	const slice = text.slice(start, end);
	const headerEnd = slice.indexOf("\n");
	if (headerEnd < 0) return [];
	const properties: SceneProperty[] = [];
	let cursor = headerEnd + 1;
	while (cursor < slice.length) {
		const lineEnd = slice.indexOf("\n", cursor);
		const stop = lineEnd < 0 ? slice.length : lineEnd;
		const line = slice.slice(cursor, stop);
		const match = PROPERTY_LINE.exec(line);
		if (!match) {
			cursor = stop + 1;
			continue;
		}
		// A value may continue on following lines (dictionaries, arrays). Inside
		// a node section anything that is neither a property nor a section header
		// or comment belongs to the value above it.
		let valueStop = stop;
		let scan = stop + 1;
		while (scan < slice.length) {
			const nextEnd = slice.indexOf("\n", scan);
			const nextStop = nextEnd < 0 ? slice.length : nextEnd;
			const nextLine = slice.slice(scan, nextStop);
			if (nextLine.startsWith("[") || nextLine.startsWith(";")) break;
			if (PROPERTY_LINE_START.test(nextLine)) break;
			if (nextLine.trim().length) valueStop = nextStop;
			scan = nextStop + 1;
		}
		const equals = line.indexOf("=");
		let valueStart = cursor + equals + 1;
		while (valueStart < stop && (slice[valueStart] === " " || slice[valueStart] === "\t")) valueStart++;
		const raw = text.slice(start + valueStart, start + valueStop).trimEnd();
		const reference = /^ExtResource\s*\(/.test(raw)
			? "ExtResource"
			: /^SubResource\s*\(/.test(raw)
				? "SubResource"
				: undefined;
		properties.push({
			name: match[1],
			raw,
			start: start + cursor,
			end: start + valueStart + raw.length,
			valueStart: start + valueStart,
			valueEnd: start + valueStart + raw.length,
			...(reference ? { reference } : {}),
		});
		cursor = stop + 1;
	}
	return properties;
}

export interface TextEditPlan {
	start: number;
	end: number;
	newText: string;
}

/** Finds a property by name, matching Godot's property paths. */
export function findProperty(properties: readonly SceneProperty[], name: string): SceneProperty | undefined {
	return properties.find((property) => property.name === name);
}

/**
 * Plans an edit that sets `value` on `name`, or removes the override when
 * `value` is `null`. Writes stay surgical: an update only replaces the value
 * range so the surrounding formatting of the scene file survives, and a new
 * property is appended to the section it belongs to.
 */
export function planPropertyWrite(
	text: string,
	section: NodeSection,
	name: string,
	value: string | null,
): TextEditPlan | undefined {
	const existing = findProperty(section.properties, name);
	if (existing) {
		if (value === null) {
			// Delete the whole statement line, including its line break.
			return { start: existing.start, end: lineBreakEnd(text, existing.end, section.bodyEnd), newText: "" };
		}
		return { start: existing.valueStart, end: existing.valueEnd, newText: value };
	}
	if (value === null) return undefined;
	// Append after the last property, or directly under the node header.
	const last = section.properties[section.properties.length - 1];
	const insertion = last ? lineBreakEnd(text, last.end, section.bodyEnd) : section.headerEnd;
	const lineEnding = text.includes("\r\n") ? "\r\n" : "\n";
	const prefix = section.properties.length ? "" : lineEnding;
	return { start: insertion, end: insertion, newText: `${prefix}${name} = ${value}` };
}

/** Offset just past the line break that ends the line containing `offset`. */
function lineBreakEnd(text: string, offset: number, limit: number): number {
	const index = text.indexOf("\n", offset);
	if (index < 0 || index >= limit) return limit;
	return index + 1;
}
