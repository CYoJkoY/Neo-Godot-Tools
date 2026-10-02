/**
 * HTML/JavaScript for the Resource Inspector webview.
 *
 * The page is intentionally dependency free: it renders the model sent by the
 * extension and posts back small edit commands, which keeps the raw text file
 * the single source of truth.
 */

import { randomBytes } from "node:crypto";
import type * as vscode from "vscode";

/**
 * The webview's script.
 *
 * It is kept in a `String.raw` template literal on purpose: inside the HTML
 * template literal below, a backslash written for a regular expression (`\s`)
 * would be consumed by the outer string and reach the browser as `s`, which
 * turns the whole script into a syntax error and leaves the panel blank.
 */
const WEBVIEW_SCRIPT = String.raw`
const vscode = acquireVsCodeApi();
const app = document.getElementById("app");

function post(command, data) { vscode.postMessage(Object.assign({ command: command }, data || {})); }

function element(tag, props, children) {
	const el = document.createElement(tag);
	for (const key of Object.keys(props || {})) {
		if (key === "class") el.className = props[key];
		else if (key === "text") el.textContent = props[key];
		else if (key === "value") el.value = props[key];
		else if (key.startsWith("on") && typeof props[key] === "function") el.addEventListener(key.slice(2), props[key]);
		else el.setAttribute(key, props[key]);
	}
	for (const child of children || []) if (child) el.appendChild(child);
	return el;
}

/** Normalize on commit, never while typing or on initial render. */
function normalizeNumericValue(raw, options) {
	if (String(raw).trim() === "") return undefined;
	let value = Number(raw);
	if (!Number.isFinite(value)) return undefined;
	const spec = options || {};
	const min = spec.allowLesser ? undefined : spec.integer && spec.min !== undefined ? Math.ceil(spec.min) : spec.min;
	const max = spec.allowGreater ? undefined : spec.integer && spec.max !== undefined ? Math.floor(spec.max) : spec.max;
	if (min !== undefined) value = Math.max(min, value);
	if (max !== undefined) value = Math.min(max, value);
	const step = spec.integer ? Math.max(1, Math.round(spec.step || 1)) : spec.step;
	if (step && Number.isFinite(step) && step > 0) {
		const origin = spec.min === undefined ? 0 : spec.integer ? Math.ceil(spec.min) : spec.min;
		value = Number((origin + Math.round((value - origin) / step) * step).toPrecision(15));
	}
	if (spec.integer) value = Math.round(value);
	if (min !== undefined) value = Math.max(min, value);
	if (max !== undefined) value = Math.min(max, value);
	return value;
}

function numberInput(value, options, commit) {
	const spec = options || {};
	let lastValue = String(value);
	const input = element("input", { type: "number", value: lastValue, step: spec.integer ? Math.max(1, Math.round(spec.step || 1)) : spec.step || "any" });
	if (spec.min !== undefined && !spec.allowLesser) input.min = String(spec.integer ? Math.ceil(spec.min) : spec.min);
	if (spec.max !== undefined && !spec.allowGreater) input.max = String(spec.integer ? Math.floor(spec.max) : spec.max);
	input.addEventListener("change", () => {
		const next = normalizeNumericValue(input.value, spec);
		if (next === undefined) { input.value = lastValue; return; }
		input.value = lastValue = String(next);
		commit(lastValue);
	});
	return input;
}

function numericEditor(property, set) {
	const widget = property.widget;
	let slider;
	const logarithmic = widget.exponential && widget.min > 0 && widget.max > widget.min;
	const toSlider = (value) => logarithmic ? Math.log(Math.max(widget.min, Number(value)) / widget.min) / Math.log(widget.max / widget.min) : Number(value);
	const fromSlider = (value) => logarithmic ? widget.min * Math.pow(widget.max / widget.min, Number(value)) : Number(value);
	const input = numberInput(property.raw, widget, (value) => { if (slider) slider.value = String(toSlider(value)); set(value); });
	input.setAttribute("aria-label", property.name);
	const container = element("div", { class: "numeric-control" }, [input]);
	if (widget.min !== undefined && widget.max !== undefined && widget.min < widget.max && !widget.hideSlider) {
		slider = element("input", { type: "range", min: logarithmic ? 0 : widget.min, max: logarithmic ? 1 : widget.max,
			step: logarithmic ? 0.001 : widget.integer ? Math.max(1, Math.round(widget.step || 1)) : widget.step || "any",
			value: toSlider(property.raw), "aria-label": property.name + " slider" });
		slider.addEventListener("input", () => { input.value = String(normalizeNumericValue(fromSlider(slider.value), widget)); });
		slider.addEventListener("change", () => {
			const value = normalizeNumericValue(fromSlider(slider.value), widget);
			if (value !== undefined) { input.value = String(value); slider.value = String(toSlider(value)); set(String(value)); }
		});
		container.appendChild(slider);
	}
	const hints = [];
	if (widget.min !== undefined || widget.max !== undefined) hints.push((widget.min === undefined || widget.allowLesser ? "−∞" : widget.min) + " … " + (widget.max === undefined || widget.allowGreater ? "∞" : widget.max));
	if (widget.step !== undefined) hints.push("step " + widget.step);
	if (widget.suffix) hints.push(widget.suffix);
	if (hints.length) container.appendChild(element("span", { class: "range-hint", text: hints.join(" · ") }));
	return container;
}

function numericComponents(property) {
	if (property.components) return property.components.slice();
	// Do not mistake the 2 in Vector2 or an exponent for a component.
	const raw = property.raw;
	const body = raw.includes("(") ? raw.slice(raw.indexOf("(") + 1, raw.lastIndexOf(")")) : raw;
	return (body.match(/[+-]?(?:\d+\.?\d*|\.\d+)(?:[eE][+-]?\d+)?/g) || []).map(Number);
}

let imageTooltip;
let positionImagePreview;
function hideImagePreview() { if (imageTooltip) imageTooltip.hidden = true; }

function showImagePreview(preview, anchor) {
	if (!imageTooltip) {
		imageTooltip = element("div", { id: "image-preview", class: "image-preview", role: "tooltip" });
		document.body.appendChild(imageTooltip);
	}
	imageTooltip.textContent = "";
	imageTooltip.hidden = false;
	const caption = element("div", { class: "preview-caption", text: preview.path });
	const status = element("div", { class: "preview-status", text: preview.message || "" });
	const place = () => {
		if (!anchor.getBoundingClientRect || !imageTooltip.getBoundingClientRect) return;
		const rect = anchor.getBoundingClientRect();
		if (rect.bottom < 0 || rect.top > window.innerHeight) { hideImagePreview(); return; }
		const size = imageTooltip.getBoundingClientRect();
		const left = Math.max(8, Math.min(rect.left, window.innerWidth - size.width - 8));
		const below = rect.bottom + 8;
		const top = below + size.height <= window.innerHeight - 8 ? below : Math.max(8, rect.top - size.height - 8);
		imageTooltip.style.left = left + "px";
		imageTooltip.style.top = top + "px";
	};
	if (preview.uri) {
		const image = element("img", { src: preview.uri, alt: preview.path });
		image.addEventListener("load", () => { status.textContent = image.naturalWidth + " × " + image.naturalHeight; place(); });
		image.addEventListener("error", () => { image.hidden = true; status.textContent = "Unable to load image preview."; place(); });
		imageTooltip.appendChild(image);
	}
	imageTooltip.appendChild(caption);
	imageTooltip.appendChild(status);
	positionImagePreview = place;
	place();
}

function bindImagePreview(anchor, preview) {
	if (!preview) return;
	anchor.title = preview.path + (preview.message ? " · " + preview.message : "");
	anchor.addEventListener("mouseenter", () => showImagePreview(preview, anchor));
	anchor.addEventListener("mouseleave", hideImagePreview);
	anchor.addEventListener("focusin", () => showImagePreview(preview, anchor));
	anchor.addEventListener("focusout", hideImagePreview);
}

function imageThumbnail(preview, open) {
	if (!preview) return undefined;
	const button = element("button", { class: "image-thumbnail", title: "Open image: " + preview.path, "aria-label": "Open image: " + preview.path, onclick: open });
	if (preview.uri) {
		const image = element("img", { src: preview.uri, loading: "lazy", alt: "" });
		image.addEventListener("error", () => { image.hidden = true; button.textContent = "▧"; });
		button.appendChild(image);
	} else button.textContent = "▧";
	bindImagePreview(button, preview);
	return button;
}

function normalizeTextValue(rawInput, type, widgetKind) {
	const trimmed = String(rawInput).trim();
	if (widgetKind === "nodepath" || type === "NodePath") {
		if (!trimmed || trimmed === "null") return 'NodePath("")';
		if (/^NodePath\([\s\S]*\)$/.test(trimmed)) return trimmed;
		const unquoted = (trimmed.startsWith('"') && trimmed.endsWith('"')) ? trimmed.slice(1, -1) : trimmed;
		return 'NodePath("' + unquoted.replace(/\\/g, "\\\\").replace(/"/g, '\\"') + '")';
	}
	if (type === "String") {
		if (trimmed === "null") return '""';
		if ((trimmed.startsWith('"') && trimmed.endsWith('"')) || (trimmed.startsWith("'") && trimmed.endsWith("'"))) {
			return rawInput;
		}
		return '"' + String(rawInput).replace(/\\/g, "\\\\").replace(/"/g, '\\"') + '"';
	}
	if (type === "StringName") {
		if (!trimmed || trimmed === "null") return '&""';
		if (trimmed.startsWith('&"') || trimmed.startsWith('@"') || /^StringName\(/.test(trimmed)) return trimmed;
		const unquoted = (trimmed.startsWith('"') && trimmed.endsWith('"')) ? trimmed.slice(1, -1) : trimmed;
		return '&"' + unquoted.replace(/\\/g, "\\\\").replace(/"/g, '\\"') + '"';
	}
	return rawInput;
}

const openSubResources = new Set();
const closedSubResources = new Set();
const openVectors = new Set();

function propertyRow(property, model, commit, revert) {
	const defaultValue = property.metadata && property.metadata.source !== "file" ? property.metadata.defaultValue : undefined;
	// The extension compares parsed literals; the webview must not guess defaults.
	const modified = property.modified === undefined ? Boolean(property.definedInFile) : property.modified;
	const row = element("div", { class: "row property-row" + (modified ? " modified" : "") });
	row.setAttribute("data-search", (property.name + " " + (property.metadata && property.metadata.type || "") + " " + (property.metadata && property.metadata.category || "")).toLowerCase());
	const displayLabel = property.metadata && property.metadata.name || property.name;
	const heading = element("div", { class: "property-heading" }, [
		element("label", { text: displayLabel, title: (property.metadata && property.metadata.type ? property.metadata.type + " · " : "") + property.name }),
		element("span", { class: "type-badge", text: property.metadata && property.metadata.type || "Variant" }),
	]);
	if (defaultValue === undefined) heading.title = property.definedInFile === false ? "Default unavailable; this is an editing placeholder, not the engine default." : "Default unknown. Reverting removes this override so Godot uses its default.";
	row.appendChild(heading);

	const widget = property.widget || { kind: "text" };
	const metaType = property.metadata && property.metadata.type;
	const set = (value) => commit(property.name, value, property.target);
	let control;

	if (widget.kind === "checkbox") {
		control = element("input", { type: "checkbox", "aria-label": property.name });
		control.checked = property.raw.trim() === "true";
		control.addEventListener("change", () => set(control.checked ? "true" : "false"));
	} else if (widget.kind === "number") {
		control = numericEditor(property, set);
	} else if (widget.kind === "enum") {
		control = element("select", { "aria-label": property.name });
		let nextValue = 0;
		for (const option of widget.options || []) {
			const parts = String(option).split(":");
			const label = parts[0].trim();
			const numeric = parts[1] !== undefined && Number.isFinite(Number(parts[1])) ? Number(parts[1]) : nextValue;
			const value = metaType === "String" ? JSON.stringify(label) : String(numeric);
			control.appendChild(element("option", { value: value, text: label }));
			nextValue = numeric + 1;
		}
		const raw = property.raw.trim();
		if (!Array.from(control.children).some((option) => option.value === raw)) control.appendChild(element("option", { value: raw, text: "Current: " + raw }));
		control.value = raw;
		control.addEventListener("change", () => set(control.value));
	} else if (widget.kind === "flags") {
		control = element("div", { class: "flags-control" });
		let flags;
		try { flags = BigInt(property.raw.trim()); } catch { flags = 0n; }
		(widget.options || []).forEach((option, index) => {
			const parts = String(option).split(":");
			let mask = 1n << BigInt(index);
			if (parts[1] !== undefined) { try { mask = BigInt(parts[1].trim()); } catch { /* keep the implicit mask */ } }
			const checkbox = element("input", { type: "checkbox" });
			checkbox.checked = mask === 0n ? flags === 0n : (flags & mask) === mask;
			checkbox.addEventListener("change", () => { flags = mask === 0n ? 0n : checkbox.checked ? flags | mask : flags & ~mask; set(String(flags)); });
			control.appendChild(element("label", {}, [checkbox, element("span", { text: parts[0].trim() })]));
		});
	} else if (widget.kind === "color") {
		const components = numericComponents(property);
		while (components.length < 4) components.push(components.length === 3 ? 1 : 0);
		const hex = "#" + components.slice(0, 3).map((value) => Math.round(Math.max(0, Math.min(1, value)) * 255).toString(16).padStart(2, "0")).join("");
		const picker = element("input", { type: "color", value: hex, "aria-label": property.name + " color" });
		const alpha = numberInput(components[3], { min: 0, max: 1, step: 0.01 }, (value) => {
			const parts = picker.value.slice(1).match(/../g).map((part) => Number((parseInt(part, 16) / 255).toFixed(4)));
			set("Color(" + parts.join(", ") + ", " + value + ")");
		});
		alpha.setAttribute("aria-label", property.name + " alpha");
		picker.addEventListener("change", () => {
			const parts = picker.value.slice(1).match(/../g).map((part) => Number((parseInt(part, 16) / 255).toFixed(4)));
			set("Color(" + parts.join(", ") + ", " + alpha.value + ")");
		});
		control = element("div", { class: "group" }, [picker, alpha]);
	} else if (widget.kind === "vector") {
		const numbers = numericComponents(property);
		const constructor = property.constructorName || property.raw.split("(")[0].trim() || metaType || "Vector2";
		const count = widget.components || numbers.length;
		const components = numbers.slice();
		while (components.length < count) components.push(0);
		const labels = /^Rect2/.test(constructor) ? ["x", "y", "w", "h"] : ["x", "y", "z", "w"];
		const fields = [];
		for (let index = 0; index < count; index++) {
			const label = count <= 4 ? labels[index] : String(index + 1);
			const input = numberInput(components[index], widget, (value) => {
				components[index] = Number(value);
				set(constructor + "(" + components.join(", ") + ")");
			});
			input.setAttribute("aria-label", property.name + " " + label);
			fields.push(element("label", { class: "component-field" }, [element("span", { text: label }), input]));
		}
		const vectorKey = (property.target || "") + ":" + property.name;
		control = element("details", openVectors.has(vectorKey) ? { open: "open" } : {}, [
			element("summary", { text: property.raw }), element("div", { class: "group" }, fields),
		]);
		control.addEventListener("toggle", () => { if (control.open) openVectors.add(vectorKey); else openVectors.delete(vectorKey); });
	} else if (widget.kind === "array") {
		control = arrayEditor(property, set);
	} else if (widget.kind === "dictionary") {
		control = dictionaryEditor(property, set);
	} else if (widget.kind === "resource") {
		const references = [];
		const referenceValue = (kind, id) => model && model.format === "2" && /^\d+$/.test(id) ? kind + "Resource( " + id + " )" : kind + "Resource(" + JSON.stringify(id) + ")";
		const type = property.metadata && property.metadata.type;
		const compatible = type && type !== "Resource" && type !== "Variant" ? type : undefined;
		// Script and Shader slots must not offer unrelated textures/materials.
		const accepts = (actual) => (type !== "Script" && type !== "Shader") || actual === type;
		for (const resource of (model && model.extResources) || []) if (accepts(resource.type)) references.push({ value: referenceValue("Ext", resource.id), id: resource.id, kind: "Ext", label: (resource.path || resource.id) + " · " + resource.type });
		for (const sub of (model && model.subResources) || []) if (accepts(sub.type)) references.push({ value: referenceValue("Sub", sub.id), id: sub.id, kind: "Sub", label: sub.type + " · " + sub.id });
		const picker = element("select", { class: "res-picker", "aria-label": property.name });
		picker.appendChild(element("option", { value: "null", text: "None (null)" }));
		for (const reference of references) picker.appendChild(element("option", { value: reference.value, text: reference.label }));
		const rawTrimmed = property.raw.trim();
		const refMatch = rawTrimmed.match(/^(Ext|Sub)Resource\(\s*(?:"([^"]*)"|(\d+))\s*\)$/);
		const current = refMatch && references.find((ref) => ref.kind === refMatch[1] && ref.id === (refMatch[2] !== undefined ? refMatch[2] : refMatch[3]));
		const selected = current ? current.value : rawTrimmed === "nil" ? "null" : rawTrimmed;
		if (!Array.from(picker.children).some((option) => option.value === selected)) picker.appendChild(element("option", { value: selected, text: "Current: " + rawTrimmed }));
		picker.value = selected;
		picker.title = current ? current.label : rawTrimmed;
		picker.addEventListener("change", () => set(picker.value));
		const preview = property.imagePreview;
		const openImage = () => post("openImage", { name: property.name, target: property.target });
		const main = element("div", { class: "res-main" }, [
			imageThumbnail(preview, openImage), picker,
			element("button", { class: "tonal", text: "Browse…", onclick: () => post("pickResource", { name: property.name, target: property.target }) }),
		]);
		bindImagePreview(main, preview);
		control = element("div", { class: "res" }, [main]);
		const actions = [];
		if (current && current.kind === "Ext") actions.push(element("button", { class: "text-button", text: "↗ Open", title: current.label, onclick: () => post("openExtResource", { id: current.id }) }));
		if (widget.creatable && compatible && compatible !== "Script") actions.push(element("button", { class: "text-button", text: "New " + compatible, title: "Create a " + compatible + " and assign it", onclick: () => post("createSubResource", { name: property.name, target: property.target, subType: compatible }) }));
		if (actions.length) control.appendChild(element("div", { class: "res-actions" }, actions));
	} else if (widget.kind === "textarea") {
		control = element("textarea", { rows: "4", value: property.raw, "aria-label": property.name, onchange: (event) => set(normalizeTextValue(event.target.value, metaType, widget.kind)) });
	} else {
		control = element("input", { type: "text", value: property.raw, "aria-label": property.name, onchange: (event) => set(normalizeTextValue(event.target.value, metaType, widget.kind)) });
	}
	if (property.imagePreview && widget.kind !== "resource") {
		const input = control;
		control = element("div", { class: "image-value" }, [input, imageThumbnail(property.imagePreview, () => post("openImage", { name: property.name, target: property.target }))]);
		bindImagePreview(control, property.imagePreview);
	}
	control.className = (control.className || "") + " property-control";
	row.appendChild(control);

	const revertButton = element("button", { class: "revert", text: "⟲", title: defaultValue !== undefined ? "Revert to default (" + defaultValue + ")" : "Remove override" });
	revertButton.disabled = property.definedInFile === false;
	revertButton.addEventListener("click", () => revert(property.name, defaultValue, property.target));
	row.appendChild(revertButton);
	if (row.querySelectorAll) Array.from(row.querySelectorAll("input, select, textarea, button")).forEach((field, index) => {
		// Preview thumbnails can appear/disappear before a picker. Identify the
		// actual field, rather than transferring focus to its old child index.
		const key = field.getAttribute("aria-label") || (field.classList.contains("revert") ? "revert" : field.textContent + ":" + index);
		field.setAttribute("data-focus-id", (property.target || "") + ":" + property.name + ":" + field.tagName + ":" + key);
	});
	return row;
}

/** Splits on commas that are outside quotes and brackets. */
function splitTopLevel(text) {
	const parts = [];
	let depth = 0;
	let quote = undefined;
	let start = 0;
	for (let index = 0; index < text.length; index++) {
		const char = text[index];
		if (quote) {
			if (char === "\\") index++;
			else if (char === quote) quote = undefined;
			continue;
		}
		if (char === '"' || char === "'") { quote = char; continue; }
		if (char === "(" || char === "[" || char === "{") depth++;
		else if (char === ")" || char === "]" || char === "}") depth--;
		else if (char === "," && depth === 0) {
			parts.push(text.slice(start, index).trim());
			start = index + 1;
		}
	}
	const tail = text.slice(start).trim();
	if (tail) parts.push(tail);
	return parts.filter((part) => part !== "");
}

/**
 * Describes the container a list value is written in, so it can be written back
 * in the same shape: [1, 2], Array[Vector2]([...]) or PackedStringArray(...).
 */
function listForm(raw) {
	const text = raw.trim();
	const match = text.match(/^([A-Za-z_][A-Za-z0-9_]*(?:\[[^\]]*\])?)\(([\s\S]*)\)$/);
	if (match) {
		let body = match[2].trim();
		const wrapped = body.startsWith("[") && body.endsWith("]");
		if (wrapped) body = body.slice(1, -1);
		return { name: match[1], body, wrapped };
	}
	if (text.startsWith("[") && text.endsWith("]")) return { name: "", body: text.slice(1, -1), wrapped: true };
	return { name: "", body: text, wrapped: false };
}

function parseList(raw) {
	return splitTopLevel(listForm(raw).body);
}

function serializeList(form, items) {
	const body = items.join(", ");
	if (!form.name) return "[" + body + "]";
	// Typed arrays keep their inner brackets; packed arrays take a flat list.
	const inner = form.wrapped || form.name === "Array" ? "[" + body + "]" : body;
	return form.name + "(" + inner + ")";
}

/** A placeholder that is valid Godot syntax for the container's element type. */
function defaultListEntry(form) {
	const typed = form.name.match(/^Array\[([^\]]*)\]$/);
	if (typed) {
		switch (typed[1]) {
			case "String": return '""';
			case "Vector2": return "Vector2(0, 0)";
			case "Vector2i": return "Vector2i(0, 0)";
			case "Vector3": return "Vector3(0, 0, 0)";
			case "Vector3i": return "Vector3i(0, 0, 0)";
			case "Color": return "Color(0, 0, 0, 1)";
			default: return "null";
		}
	}
	if (/StringArray$/.test(form.name)) return '""';
	if (/Array$/.test(form.name)) return "0";
	return "null";
}

function arrayEditor(property, set) {
	const form = listForm(property.raw);
	const items = parseList(property.raw);
	const container = element("div", {});
	const render = () => {
		container.textContent = "";
		items.forEach((item, index) => {
			const input = element("input", { type: "text", value: item });
			input.addEventListener("change", () => { items[index] = input.value; commit(); });
			const up = element("button", { text: "\u2191", onclick: () => { if (index > 0) { items.splice(index - 1, 0, items.splice(index, 1)[0]); commit(); } } });
			const down = element("button", { text: "\u2193", onclick: () => { if (index < items.length - 1) { items.splice(index + 1, 0, items.splice(index, 1)[0]); commit(); } } });
			const remove = element("button", { text: "\u2715", onclick: () => { items.splice(index, 1); commit(); } });
			container.appendChild(element("div", { class: "entry" }, [input, up, down, remove]));
		});
		container.appendChild(element("button", { text: "Add entry", onclick: () => { items.push(defaultListEntry(form)); commit(); } }));
	};
	function commit() {
		// Write the value back in the container it came from, so editing an array
		// never rewrites [1, 2] into something Godot can no longer load.
		set(serializeList(form, items));
		render();
	}
	render();
	return container;
}

function dictionaryEditor(property, set) {
	const text = property.raw.trim();
	// Dictionary[K, V]({...}) is typed; keep the prefix when writing back.
	const typed = text.match(/^(Dictionary\[[^\]]*\])\(([\s\S]*)\)$/);
	const plain = text.match(/^\s*\{([\s\S]*)\}\s*$/);
	const body = typed ? typed[2].trim() : (plain ? plain[1].trim() : "");
	const entries = body
		? splitTopLevel(body.replace(/^\{/, "").replace(/\}$/, "")).map((part) => {
			const separator = part.indexOf(":");
			return { key: part.slice(0, separator).trim(), value: part.slice(separator + 1).trim() };
		})
		: [];
	const container = element("div", {});
	const render = () => {
		container.textContent = "";
		entries.forEach((entry, index) => {
			const key = element("input", { type: "text", value: entry.key });
			const value = element("input", { type: "text", value: entry.value });
			key.addEventListener("change", () => { entry.key = key.value; commit(); });
			value.addEventListener("change", () => { entry.value = value.value; commit(); });
			const remove = element("button", { text: "\u2715", onclick: () => { entries.splice(index, 1); commit(); } });
			container.appendChild(element("div", { class: "entry kv" }, [key, value, remove]));
		});
		container.appendChild(element("button", { text: "Add pair", onclick: () => { entries.push({ key: '"key"', value: "null" }); commit(); } }));
	};
	function commit() {
		const literal = "{" + entries.map((entry) => entry.key + ": " + entry.value).join(", ") + "}";
		set(typed ? typed[1] + "(" + literal + ")" : literal);
		render();
	}
	render();
	return container;
}

let currentSearch = "";
let modifiedOnly = false;
let renderedResourceUri;

function applyPropertyFilters() {
	if (!app || typeof app.querySelectorAll !== "function") return;
	const rows = Array.from(app.querySelectorAll(".property-row"));
	const query = currentSearch.trim().toLowerCase();
	let visible = 0;
	for (const row of rows) {
		const matchesText = !query || (row.getAttribute("data-search") || "").includes(query);
		const matchesModified = !modifiedOnly || row.classList.contains("modified");
		row.hidden = !matchesText || !matchesModified;
		if (!row.hidden) {
			visible++;
			const parentResource = row.closest && row.closest("details");
			if (parentResource && (query || modifiedOnly)) parentResource.open = true;
		}
	}
	const count = document.getElementById("property-count");
	if (count) count.textContent = visible + " shown";
}

function renderEmpty(resources) {
	app.textContent = "";
	const container = element("div", { class: "empty-state" }, [
		element("div", { class: "eyebrow", text: "RESOURCE INSPECTOR" }),
		element("p", { class: "empty", text: "Open a .tres file in the editor to inspect it automatically, or choose one below." }),
		element("div", { class: "toolbar empty-toolbar" }, [
			element("button", { class: "filled", text: "Browse .tres file…", onclick: () => post("browseResourceFile", {}) }),
			element("button", { class: "tonal", text: "↻  Refresh", onclick: () => post("reload", {}) }),
		]),
	]);

	if (resources && resources.length) {
		const listSection = element("section", { class: "resource-section" });
		listSection.appendChild(element("div", { class: "section-heading" }, [
			element("h3", { text: "Workspace Resources" }),
			element("span", { class: "count", text: resources.length + " .tres" }),
		]));
		for (const item of resources) {
			const link = element("button", {
				class: "resource-link",
				text: "↗  " + (item.resourcePath || item.label),
				title: item.resourcePath || item.label,
				onclick: () => post("openResource", { uri: item.uri }),
			});
			listSection.appendChild(element("div", { class: "external-row workspace-resource-row" }, [
				element("code", { class: "resource-id", text: item.label }),
				link,
			]));
		}
		container.appendChild(listSection);
	}
	app.appendChild(container);
}

function render(model, resources) {
	const active = document.activeElement;
	const searchWasFocused = active && active.id === "property-search";
	const filterWasFocused = active && active.id === "modified-filter";
	const focusId = model && model.uri === renderedResourceUri && active && active.getAttribute && active.getAttribute("data-focus-id");
	const selectionStart = active && active.selectionStart;
	const selectionEnd = active && active.selectionEnd;
	hideImagePreview();
	app.textContent = "";
	if (!model) {
		renderedResourceUri = undefined;
		renderEmpty(resources);
		return;
	}
	const headerChildren = [
		element("div", { class: "eyebrow", text: "GODOT RESOURCE" + (model.format ? " · FORMAT " + model.format : "") }),
		element("h2", { text: model.resourceType + (model.scriptClass ? " · " + model.scriptClass : "") }),
	];
	if (model.resourcePath || model.fileName) {
		headerChildren.push(element("div", { class: "resource-path", text: model.resourcePath || model.fileName }));
	}
	app.appendChild(element("header", { class: "resource-header" }, headerChildren));

	const toolbarButtons = [
		element("button", { class: "filled", text: "Open raw text", onclick: () => post("openText", {}) }),
	];
	if (model.scriptPath) {
		toolbarButtons.push(element("button", { class: "tonal", text: "Script", title: model.scriptPath, onclick: () => post("openScript", {}) }));
	}
	toolbarButtons.push(
		element("button", {
			class: "tonal" + (model.locked ? " active" : ""),
			text: model.locked ? "🔒 Locked" : "🔓 Auto",
			title: model.locked ? "Unlock to follow the active .tres editor" : "Lock inspector to this .tres resource",
			onclick: () => post("toggleLock", {}),
		}),
		element("button", { class: "tonal", text: "↻  Reload", onclick: () => post("reload", {}) }),
	);
	app.appendChild(element("div", { class: "toolbar" }, toolbarButtons));

	if (model.diagnostics && model.diagnostics.length) {
		const list = element("ul", { class: "diagnostics" });
		for (const diagnostic of model.diagnostics) {
			list.appendChild(element("li", { class: diagnostic.severity, text: diagnostic.message }));
		}
		app.appendChild(list);
	}

	const propertyHeader = element("div", { class: "section-heading" }, [
		element("h3", { text: "Properties" }),
		element("span", { id: "property-count", class: "count", text: model.properties.length + " properties" }),
	]);
	app.appendChild(propertyHeader);
	const tools = element("div", { class: "property-tools" });
	const search = element("input", { id: "property-search", type: "search", placeholder: "Search properties…", value: currentSearch, "aria-label": "Search properties" });
	search.addEventListener("input", () => { currentSearch = search.value; applyPropertyFilters(); });
	const modifiedButton = element("button", { id: "modified-filter", class: "filter-button" + (modifiedOnly ? " active" : ""), text: "●  Modified" });
	modifiedButton.setAttribute("aria-pressed", String(modifiedOnly));
	modifiedButton.addEventListener("click", () => { modifiedOnly = !modifiedOnly; render(model); });
	tools.appendChild(search);
	tools.appendChild(modifiedButton);
	app.appendChild(tools);

	const commit = (name, value, target) => post("setProperty", { name: name, value: value, target: target });
	const revert = (name, defaultValue, target) => post("revertProperty", { name: name, defaultValue: defaultValue, target: target });
	const propertyContainer = element("section", { class: "property-list" });
	let lastCategory = undefined;
	for (const property of model.properties) {
		const category = property.metadata && (property.metadata.group || property.metadata.category);
		if (category && category !== lastCategory) {
			lastCategory = category;
			propertyContainer.appendChild(element("div", { class: "category-heading", text: category }));
		}
		propertyContainer.appendChild(propertyRow(property, model, commit, revert));
	}
	app.appendChild(propertyContainer);
	app.appendChild(element("button", { class: "tonal add-resource", text: "+  Add property", onclick: () => post("addProperty", {}) }));

	const subSection = element("section", { class: "resource-section" });
	subSection.appendChild(element("div", { class: "section-heading" }, [
		element("h3", { text: "Sub-resources" }),
		element("span", { class: "count", text: model.subResources.length + " total" }),
	]));
	const defaultSubOpen = model.subResources.length <= 2;
	for (const sub of model.subResources) {
		const body = element("div", { class: "subresource-body" });
		for (const property of sub.properties) body.appendChild(propertyRow(Object.assign({}, property, { target: sub.id }), model, commit, revert));
		const actions = element("div", { class: "subresource-actions" }, [
			element("button", { class: "text-button", text: "+ Property", onclick: () => post("addProperty", { target: sub.id }) }),
			element("button", { class: "text-button", text: "Duplicate", onclick: () => post("duplicateSubResource", { id: sub.id }) }),
			element("button", { class: "text-button", text: "Rename", onclick: () => post("renameSubResource", { id: sub.id }) }),
			element("button", { class: "text-button danger", text: "Delete", onclick: () => post("deleteSubResource", { id: sub.id }) }),
		]);
		const isOpen = openSubResources.has(sub.id) || (defaultSubOpen && !closedSubResources.has(sub.id));
		const card = element("details", Object.assign({ class: "resource-card" }, isOpen ? { open: "open" } : {}), [
			element("summary", {}, [element("span", { class: "resource-type", text: sub.type, title: sub.type }), element("code", { text: sub.id, title: sub.id })]),
			body,
			actions,
		]);
		card.addEventListener("toggle", () => {
			if (card.open) {
				openSubResources.add(sub.id);
				closedSubResources.delete(sub.id);
			} else {
				openSubResources.delete(sub.id);
				closedSubResources.add(sub.id);
			}
		});
		subSection.appendChild(card);
	}
	const addSub = element("button", { class: "tonal add-resource", text: "+  Add sub-resource", onclick: () => post("addSubResource", {}) });
	subSection.appendChild(addSub);
	app.appendChild(subSection);

	const extSection = element("section", { class: "resource-section" });
	extSection.appendChild(element("div", { class: "section-heading" }, [
		element("h3", { text: "External resources" }),
		element("span", { class: "count", text: model.extResources.length + " total" }),
	]));
	for (const resource of model.extResources) {
		const open = () => post("openExtResource", { id: resource.id });
		const link = element("button", { text: (resource.broken ? "⚠  " : "↗  ") + (resource.path || resource.id), title: resource.path || resource.id, class: "resource-link" + (resource.broken ? " broken" : ""), onclick: open });
		bindImagePreview(link, resource.imagePreview);
		const pathCell = element("div", { class: "resource-link-cell" }, [imageThumbnail(resource.imagePreview, open), link]);
		const removeBtn = element("button", { class: "revert", text: "\u2715", title: "Remove external resource", onclick: () => post("deleteExtResource", { id: resource.id }) });
		extSection.appendChild(element("div", { class: "external-row" }, [
			element("code", { class: "resource-id", text: resource.id }),
			element("span", { class: "type-badge", text: resource.type }),
			pathCell,
			removeBtn,
		]));
	}
	extSection.appendChild(element("button", { class: "tonal add-resource", text: "+  Add external resource", onclick: () => post("addExternalResource", {}) }));
	app.appendChild(extSection);
	applyPropertyFilters();
	renderedResourceUri = model.uri;
	if (searchWasFocused && typeof search.focus === "function") search.focus({ preventScroll: true });
	else if (filterWasFocused && typeof modifiedButton.focus === "function") modifiedButton.focus({ preventScroll: true });
	else if (focusId && app.querySelectorAll) {
		const field = Array.from(app.querySelectorAll("[data-focus-id]")).find((candidate) => candidate.getAttribute("data-focus-id") === focusId);
		if (field && !field.disabled) {
			field.focus({ preventScroll: true });
			if (selectionStart !== undefined && selectionStart !== null && typeof field.setSelectionRange === "function") field.setSelectionRange(selectionStart, selectionEnd);
		}
	}
}

window.addEventListener("keydown", (event) => {
	if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === "f") {
		event.preventDefault();
		document.getElementById("property-search")?.focus();
	}
});

// The file changed outside the panel while edits were pending: let the user pick.
function showExternalChangeBanner() {
	const banner = document.getElementById("banner");
	banner.textContent = "";
	banner.className = "banner";
	banner.appendChild(element("span", { text: "The resource changed on disk." }));
	const reload = element("button", { text: "Reload", onclick: () => { banner.className = ""; post("reload", {}); } });
	const keep = element("button", { text: "Keep changes", onclick: () => { banner.className = ""; post("keepChanges", {}); } });
	banner.appendChild(reload);
	banner.appendChild(keep);
}

window.addEventListener("message", (event) => {
	const message = event.data;
	if (message.type === "model") render(message.model);
	else if (message.type === "empty") render(undefined, message.resources);
	else if (message.type === "externalChange") showExternalChangeBanner();
});

// Scrolling to a focused/hovered field can emit a scroll event after mouseenter.
// Reposition, rather than immediately hiding a preview the user just requested.
const repositionImagePreview = () => { if (imageTooltip && !imageTooltip.hidden && positionImagePreview) positionImagePreview(); };
window.addEventListener("resize", repositionImagePreview);
window.addEventListener("scroll", repositionImagePreview, true);
post("ready", {});`;

export function resourceInspectorHtml(webview: vscode.Webview, extensionUri: vscode.Uri): string {
	void extensionUri;
	const nonce = randomBytes(16).toString("hex");
	const imageSource = webview.cspSource ?? "'none'";
	return /* html */ `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; img-src ${imageSource}; style-src 'unsafe-inline'; script-src 'nonce-${nonce}';">
<style>
	:root {
		color-scheme: light dark;
		--ri-surface: var(--vscode-sideBar-background, var(--vscode-editor-background));
		--ri-card: color-mix(in srgb, var(--vscode-foreground) 4%, var(--ri-surface));
		--ri-border: color-mix(in srgb, var(--vscode-foreground) 14%, transparent);
		--ri-muted: var(--vscode-descriptionForeground, #777);
		--ri-accent: var(--vscode-button-background, #1a73e8);
		--ri-radius: 12px;
	}
	* { box-sizing: border-box; }
	body {
		margin: 0; padding: 16px 14px 28px;
		background: var(--ri-surface); color: var(--vscode-foreground);
		font-family: "Google Sans", Roboto, var(--vscode-font-family), sans-serif;
		font-size: var(--vscode-font-size); line-height: 1.45;
	}
	button, input, select, textarea { font: inherit; }
	button { color: inherit; }
	button:focus-visible, input:focus-visible, select:focus-visible, textarea:focus-visible, summary:focus-visible {
		outline: 2px solid var(--vscode-focusBorder, #1a73e8); outline-offset: 2px;
	}
	.resource-header { padding: 4px 2px 8px; }
	.eyebrow { color: var(--ri-muted); font-size: 10px; font-weight: 700; letter-spacing: .12em; }
	.resource-path { color: var(--ri-muted); font: 11px var(--vscode-editor-font-family, monospace); margin-top: 2px; overflow-wrap: anywhere; }
	h2 { font-size: 20px; line-height: 1.3; font-weight: 600; margin: 4px 0 0; overflow-wrap: anywhere; }
	h3 { font-size: 13px; font-weight: 600; margin: 0; letter-spacing: .01em; }
	.toolbar { display: flex; flex-wrap: wrap; gap: 8px; margin: 8px 0 20px; }
	.empty-toolbar { justify-content: center; margin-top: 12px; }
	.toolbar button, .tonal, .filter-button, .text-button, .add-resource {
		min-height: 32px; border: 0; border-radius: 999px; padding: 6px 13px;
		cursor: pointer; transition: background-color .14s ease, transform .14s ease;
	}
	.toolbar button:hover, .tonal:hover, .filter-button:hover, .text-button:hover { filter: brightness(1.08); }
	.toolbar .filled { background: var(--ri-accent); color: var(--vscode-button-foreground, white); font-weight: 600; }
	.tonal, .filter-button { background: color-mix(in srgb, var(--ri-accent) 14%, var(--ri-surface)); color: var(--vscode-foreground); }
	.filter-button { white-space: nowrap; }
	.filter-button.active, .tonal.active { background: color-mix(in srgb, var(--ri-accent) 25%, var(--ri-surface)); box-shadow: inset 0 0 0 1px color-mix(in srgb, var(--ri-accent) 45%, transparent); }
	.section-heading { display: flex; justify-content: space-between; align-items: baseline; gap: 8px; margin: 20px 2px 8px; }
	.category-heading { font-size: 11px; font-weight: 700; letter-spacing: .06em; text-transform: uppercase; color: var(--ri-muted); padding: 8px 4px 2px; border-bottom: 1px solid var(--ri-border); margin-top: 4px; }
	.count { color: var(--ri-muted); font-size: 11px; }
	.property-tools { display: flex; gap: 8px; margin: 0 0 10px; }
	#property-search { flex: 1; min-width: 0; height: 34px; border-radius: 999px; padding: 0 13px; }
	input, select, textarea {
		width: 100%; min-width: 0; color: var(--vscode-input-foreground);
		background: var(--vscode-input-background); border: 1px solid var(--ri-border);
		border-radius: 8px; padding: 6px 9px;
	}
	input:hover, select:hover, textarea:hover { border-color: color-mix(in srgb, var(--ri-accent) 45%, var(--ri-border)); }
	.property-list { display: grid; gap: 5px; }
	.property-row[hidden] { display: none; }
	.row { display: grid; grid-template-areas: "heading control revert"; grid-template-columns: minmax(110px, 30%) minmax(0, 1fr) 27px; gap: 8px; align-items: center; padding: 8px 7px; border-radius: 10px; border: 1px solid transparent; }
	.row:hover { background: var(--ri-card); border-color: var(--ri-border); }
	.row.modified { border-left: 2px solid var(--ri-accent); padding-left: 6px; }
	.property-heading { grid-area: heading; min-width: 0; display: flex; flex-direction: column; gap: 2px; }
	.property-heading label { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; font-weight: 500; }
	.type-badge { width: fit-content; max-width: 100%; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; color: var(--ri-muted); font: 10px/1.4 var(--vscode-editor-font-family, monospace); }
	.property-control { grid-area: control; min-width: 0; }
	.row > .revert { grid-area: revert; align-self: start; }
	.row input, .row select, .row textarea { min-height: 30px; }
	.row input[type="checkbox"] { width: 18px; min-height: 18px; accent-color: var(--ri-accent); }
	.row input[type="color"] { padding: 3px; min-height: 34px; }
	.row textarea { resize: vertical; font-family: var(--vscode-editor-font-family, monospace); font-size: 12px; }
	.revert { width: 27px; height: 27px; padding: 0; border: 0; border-radius: 50%; background: transparent; cursor: pointer; color: var(--ri-muted); font-size: 16px; }
	.revert:hover { background: var(--ri-card); color: var(--vscode-foreground); }
	.group { display: grid; grid-template-columns: repeat(auto-fit, minmax(55px, 1fr)); gap: 6px; align-items: center; }
	.res { display: grid; grid-template-columns: minmax(0, 1fr); gap: 4px; min-width: 0; }
	.res-main, .image-value, .resource-link-cell { display: flex; gap: 6px; align-items: center; min-width: 0; }
	.res-picker, .image-value > input, .resource-link-cell > .resource-link { flex: 1; min-width: 0; width: 0; }
	.res-main > .tonal { flex-shrink: 0; padding: 5px 9px; white-space: nowrap; }
	.res-actions { display: flex; flex-wrap: wrap; gap: 4px; }
	.res-actions > button { min-height: 25px; padding: 3px 8px; }
	.numeric-control { display: grid; gap: 4px; }
	.range-hint { color: var(--ri-muted); font-size: 10px; overflow-wrap: anywhere; }
	.row input[type="range"] { min-height: 18px; height: 18px; padding: 0; border: 0; accent-color: var(--ri-accent); }
	.component-field { display: grid; grid-template-columns: auto minmax(0, 1fr); align-items: center; gap: 4px; color: var(--ri-muted); font-size: 11px; }
	.flags-control { display: flex; flex-wrap: wrap; gap: 6px 12px; }
	.flags-control > label { display: flex; align-items: center; gap: 5px; }
	button:disabled { opacity: .4; cursor: default; }
	.image-thumbnail { flex: 0 0 32px; width: 32px; height: 32px; padding: 0; overflow: hidden; background: repeating-conic-gradient(#8883 0% 25%, transparent 0% 50%) 50% / 8px 8px; }
	.image-thumbnail img { display: block; width: 100%; height: 100%; object-fit: contain; }
	.image-preview { position: fixed; z-index: 20; pointer-events: none; width: min(280px, calc(100vw - 16px)); max-height: calc(100vh - 16px); overflow: hidden; padding: 10px; border: 1px solid var(--ri-border); border-radius: 10px; background: var(--vscode-editorHoverWidget-background, var(--ri-surface)); box-shadow: 0 4px 18px #0005; }
	.image-preview[hidden], .image-preview img[hidden] { display: none; }
	.image-preview img { display: block; width: 100%; max-height: min(220px, 50vh); object-fit: contain; background: repeating-conic-gradient(#8883 0% 25%, transparent 0% 50%) 50% / 12px 12px; }
	.preview-caption { margin-top: 6px; font-size: 11px; overflow-wrap: anywhere; }
	.preview-status { color: var(--ri-muted); font-size: 10px; }
	.entry { display: grid; grid-template-columns: minmax(0, 1fr) auto auto auto; gap: 4px; align-items: center; margin: 5px 0; }
	.entry.kv { grid-template-columns: minmax(0, 1fr) minmax(0, 1fr) auto; }
	.entry button, .res button, .toolbar button, .text-button { font-size: 11px; }
	button:not(.revert) { border: 0; border-radius: 8px; cursor: pointer; }
	.resource-section { margin-top: 22px; }
	.resource-card { background: var(--ri-card); border: 1px solid var(--ri-border); border-radius: var(--ri-radius); margin: 7px 0; padding: 0 12px; }
	.resource-card > summary { display: flex; align-items: center; gap: 8px; min-height: 42px; cursor: pointer; list-style: none; }
	.resource-card > summary::-webkit-details-marker { display: none; }
	.resource-card > summary::before { content: "▸"; color: var(--ri-muted); transition: transform .15s; }
	.resource-card[open] > summary::before { transform: rotate(90deg); }
	.resource-type { font-weight: 600; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
	.resource-card > summary .resource-type { flex: 1; }
	.resource-card > summary code { min-width: 0; max-width: 45%; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
	code { font: 11px var(--vscode-editor-font-family, monospace); color: var(--ri-muted); }
	.subresource-body { border-top: 1px solid var(--ri-border); padding: 6px 0; }
	.subresource-actions { display: flex; flex-wrap: wrap; justify-content: flex-end; gap: 4px; padding: 4px 0 8px; }
	.text-button { background: transparent; color: var(--vscode-textLink-foreground, var(--ri-accent)); }
	.text-button.danger { color: var(--vscode-errorForeground); }
	.add-resource { width: 100%; margin-top: 7px; border: 1px dashed var(--ri-border); background: transparent; text-align: center; }
	.external-row { display: grid; grid-template-columns: auto auto minmax(0, 1fr) auto; align-items: center; gap: 8px; padding: 8px 4px; border-bottom: 1px solid var(--ri-border); }
	.workspace-resource-row { grid-template-columns: auto minmax(0, 1fr); }
	.resource-id { color: var(--vscode-foreground); }
	.resource-link { min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; text-align: left; background: transparent; color: var(--vscode-textLink-foreground, var(--ri-accent)); padding: 4px; }
	.broken { color: var(--vscode-errorForeground); }
	.diagnostics { padding: 10px 12px 10px 28px; border-radius: 10px; background: var(--ri-card); margin: 8px 0; }
	.diagnostics .error { color: var(--vscode-errorForeground); }
	.diagnostics .warning { color: var(--vscode-editorWarning-foreground); }
	.banner { position: sticky; z-index: 2; top: 0; display: flex; flex-wrap: wrap; gap: 8px; align-items: center; background: var(--vscode-editorWidget-background); border: 1px solid var(--vscode-editorWarning-foreground); border-radius: 12px; padding: 10px; margin-bottom: 10px; }
	.banner button { background: var(--ri-accent); color: var(--vscode-button-foreground, white); padding: 6px 10px; }
	.empty-state { text-align: center; padding: 12px 4px; }
	.empty-state .resource-section { text-align: left; }
	.empty { color: var(--ri-muted); text-align: center; padding: 12px 12px; margin: 0; }
	@media (max-width: 520px) {
		body { padding: 12px 9px 24px; }
		.row { grid-template-areas: "heading revert" "control control"; grid-template-columns: minmax(0, 1fr) 27px; gap: 6px; padding: 7px 4px; }
		.property-tools { flex-wrap: wrap; }
		#property-search { flex-basis: 100%; }
		.external-row { grid-template-columns: auto minmax(0, 1fr) auto; }
		.external-row .type-badge { display: none; }
	}
</style>
</head>
<body>
<div id="banner"></div>
<div id="app"><p class="empty">Loading resource…</p></div>
<script nonce="${nonce}">
${WEBVIEW_SCRIPT}
</script>
</body>
</html>`;
}
