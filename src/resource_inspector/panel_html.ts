/**
 * HTML/JavaScript for the Resource Inspector webview.
 *
 * The page is intentionally dependency free: it renders the model sent by the
 * extension and posts back small edit commands, which keeps the raw text file
 * the single source of truth.
 */

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

function numberInput(value, options, commit) {
	const input = element("input", { type: "number", value: value });
	if (options && options.min !== undefined) input.min = String(options.min);
	if (options && options.max !== undefined) input.max = String(options.max);
	if (options && options.step !== undefined) input.step = String(options.step);
	input.addEventListener("change", () => {
		// Never write back an empty or half-typed field: that would put NaN
		// (or nothing at all) into the resource file.
		const next = Number(input.value);
		if (input.value.trim() === "" || !Number.isFinite(next)) {
			input.value = String(value);
			return;
		}
		commit(input.value.trim());
	});
	return input;
}

function componentNumber(components, index, commit) {
	const input = element("input", { type: "number", value: components[index] });
	input.addEventListener("change", () => {
		const next = components.slice();
		next[index] = Number(input.value);
		commit(next);
	});
	return input;
}

function propertyRow(property, model, commit, revert) {
	const row = element("div", { class: "row" });
	const label = element("label", { text: property.metadata ? property.metadata.name : property.name, title: property.metadata ? property.metadata.type : "" });
	row.appendChild(label);

	const widget = property.widget || { kind: "text" };
	const set = (value) => commit(property.name, value);
	let control;

	if (widget.kind === "checkbox") {
		control = element("input", { type: "checkbox" });
		control.checked = property.raw.trim() === "true";
		control.addEventListener("change", () => set(control.checked ? "true" : "false"));
	} else if (widget.kind === "number") {
		control = numberInput(Number(property.raw), widget, (value) => set(widget.integer ? String(Math.round(Number(value))) : value));
	} else if (widget.kind === "enum") {
		control = element("select");
		const options = widget.options || [];
		options.forEach((option, index) => control.appendChild(element("option", { value: String(index), text: option })));
		const raw = property.raw.trim();
		const current = options.indexOf(raw);
		control.value = String(current === -1 && !Number.isNaN(Number(raw)) ? Number(raw) : Math.max(0, current));
		control.addEventListener("change", () => set(control.value));
	} else if (widget.kind === "color") {
		const match = property.raw.match(/-?[0-9.]+/g) || [];
		const components = match.map(Number);
		while (components.length < 4) components.push(components.length === 3 ? 1 : 0);
		const hex = "#" + components.slice(0, 3).map((value) => Math.round(Math.max(0, Math.min(1, value)) * 255).toString(16).padStart(2, "0")).join("");
		const picker = element("input", { type: "color", value: hex });
		const alpha = numberInput(components[3], { min: 0, max: 1, step: 0.01 }, (value) => {
			const parts = picker.value.slice(1).match(/../g).map((part) => parseInt(part, 16) / 255);
			set("Color(" + parts.join(", ") + ", " + value + ")");
		});
		picker.addEventListener("change", () => {
			const parts = picker.value.slice(1).match(/../g).map((part) => parseInt(part, 16) / 255);
			set("Color(" + parts.join(", ") + ", " + alpha.value + ")");
		});
		control = element("div", { class: "group" }, [picker, alpha]);
	} else if (widget.kind === "vector") {
		const numbers = (property.raw.match(/-?[0-9.]+/g) || []).map(Number);
		// Keep the constructor the file uses (Vector2i, Quat, Rect3, ...).
		const constructor = property.raw.split("(")[0].trim() || "Vector2";
		const count = widget.components || numbers.length;
		const components = numbers.slice();
		while (components.length < count) components.push(0);
		const fields = [];
		for (let index = 0; index < count; index++) {
			const input = element("input", { type: "number", value: String(components[index]) });
			input.addEventListener("change", () => {
				const next = Number(input.value);
				if (input.value.trim() === "" || !Number.isFinite(next)) {
					input.value = String(components[index]);
					return;
				}
				components[index] = next;
				set(constructor + "(" + components.join(", ") + ")");
			});
			fields.push(input);
		}
		control = element("details", {}, [
			element("summary", { text: property.raw }),
			element("div", { class: "group" }, fields),
		]);
	} else if (widget.kind === "array") {
		control = arrayEditor(property, set);
	} else if (widget.kind === "dictionary") {
		control = dictionaryEditor(property, set);
	} else if (widget.kind === "resource") {
		const references = [];
		for (const resource of (model && model.extResources) || []) references.push({ value: 'ExtResource("' + resource.id + '")', label: resource.path || resource.id });
		for (const sub of (model && model.subResources) || []) references.push({ value: 'SubResource("' + sub.id + '")', label: sub.type + " · " + sub.id });
		// A property of a concrete resource type can be filled by creating a
		// sub-resource on the spot (Godot's "New <Type>" button).
		const type = property.metadata && property.metadata.type;
		const compatible = type && type !== "Resource" && type !== "Variant" ? type : undefined;
		const picker = element("select", {});
		picker.appendChild(element("option", { value: "", text: "—" }));
		for (const reference of references) picker.appendChild(element("option", { value: reference.value, text: reference.label }));
		picker.addEventListener("change", () => { if (picker.value) set(picker.value); });
		control = element("div", { class: "res" }, [
			element("input", { type: "text", value: property.raw, onchange: (event) => set(event.target.value) }),
			picker,
			element("button", { text: "Browse…", onclick: () => post("pickResource", { name: property.name, target: property.target }) }),
		]);
		if (compatible && compatible !== "Resource") {
			control.appendChild(element("button", { text: "New " + compatible, title: "Create a " + compatible + " and assign it", onclick: () => post("createSubResource", { name: property.name, target: property.target, subType: compatible }) }));
		}
	} else if (widget.kind === "textarea") {
		control = element("textarea", { rows: "3", value: property.raw, onchange: (event) => set(event.target.value) });
	} else {
		control = element("input", { type: "text", value: property.raw, onchange: (event) => set(event.target.value) });
	}
	row.appendChild(control);

	const revertButton = element("button", { class: "revert", text: "⟲", title: "Revert to default" });
	revertButton.addEventListener("click", () => revert(property.name, property.metadata && property.metadata.defaultValue, property.target));
	row.appendChild(revertButton);
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

function render(model) {
	app.textContent = "";
	if (!model) {
		app.appendChild(element("p", { class: "empty", text: "Open a .tres file to edit it in the Resource Inspector." }));
		return;
	}
	app.appendChild(element("h2", { text: model.resourceType + (model.scriptClass ? " (" + model.scriptClass + ")" : "") }));
	const header = element("div", { class: "toolbar" }, [
		element("button", { text: "Open raw text", onclick: () => post("openText", {}) }),
		element("button", { text: "Reload", onclick: () => post("reload", {}) }),
	]);
	app.appendChild(header);

	if (model.diagnostics && model.diagnostics.length) {
		const list = element("ul", { class: "diagnostics" });
		for (const diagnostic of model.diagnostics) {
			list.appendChild(element("li", { class: diagnostic.severity, text: diagnostic.message }));
		}
		app.appendChild(list);
	}

	app.appendChild(element("h3", { text: "Properties" }));
	const commit = (name, value, target) => post("setProperty", { name: name, value: value, target: target });
	const revert = (name, defaultValue, target) => post("revertProperty", { name: name, defaultValue: defaultValue, target: target });
	for (const property of model.properties) {
		app.appendChild(propertyRow(property, model, commit, revert));
	}

	app.appendChild(element("h3", { text: "Sub-resources" }));
	const subContainer = element("div", {});
	for (const sub of model.subResources) {
		const body = element("div", {});
		for (const property of sub.properties) body.appendChild(propertyRow(Object.assign({}, property, { target: sub.id }), model, commit, revert));
		subContainer.appendChild(element("details", {}, [
			element("summary", { text: sub.type + " · " + sub.id }),
			body,
			element("div", { class: "res" }, [
				element("button", { text: "Duplicate", onclick: () => post("duplicateSubResource", { id: sub.id }) }),
				element("button", { text: "Delete", onclick: () => post("deleteSubResource", { id: sub.id }) }),
			]),
		]));
	}
	subContainer.appendChild(element("button", { text: "Add sub-resource", onclick: () => post("addSubResource", { subType: "Resource" }) }));
	app.appendChild(subContainer);

	app.appendChild(element("h3", { text: "External resources" }));
	for (const resource of model.extResources) {
		const link = element("button", { text: (resource.broken ? "⚠ " : "") + resource.path, class: resource.broken ? "broken" : "", onclick: () => post("openExtResource", { id: resource.id }) });
		app.appendChild(element("div", { class: "res" }, [element("span", { text: resource.id }), link]));
	}
}

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
	else if (message.type === "empty") render(undefined);
	else if (message.type === "externalChange") showExternalChangeBanner();
});

post("ready", {});`;

export function resourceInspectorHtml(webview: vscode.Webview, extensionUri: vscode.Uri): string {
	void webview;
	void extensionUri;
	return /* html */ `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<style>
	:root { color-scheme: light dark; }
	body { font-family: var(--vscode-font-family); font-size: var(--vscode-font-size); padding: 8px; }
	h2 { font-size: 1.05em; margin: 4px 0 8px; }
	h3 { font-size: 0.95em; margin: 12px 0 4px; text-transform: uppercase; opacity: 0.7; }
	.row { display: grid; grid-template-columns: minmax(120px, 32%) 1fr auto; gap: 6px; align-items: center; padding: 2px 0; }
	.row > label { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
	.row input, .row select, .row textarea { width: 100%; box-sizing: border-box; background: var(--vscode-input-background); color: var(--vscode-input-foreground); border: 1px solid var(--vscode-input-border, transparent); padding: 2px 4px; }
	.banner { position: sticky; top: 0; display: flex; gap: 6px; align-items: center; background: var(--vscode-editorWidget-background); border: 1px solid var(--vscode-editorWarning-foreground); padding: 6px; margin-bottom: 6px; }
	.res { grid-template-columns: auto 1fr auto auto; }
	.revert { background: none; border: none; cursor: pointer; color: var(--vscode-descriptionForeground); }
	details > summary { cursor: pointer; }
	.group { display: grid; grid-template-columns: repeat(auto-fit, minmax(70px, 1fr)); gap: 4px; }
	.entry { display: grid; grid-template-columns: 1fr auto auto auto; gap: 4px; align-items: center; margin: 2px 0; }
	.entry .kv { display: grid; grid-template-columns: 1fr 1fr auto; gap: 4px; }
	.diagnostics { margin: 6px 0; }
	.diagnostics .error { color: var(--vscode-errorForeground); }
	.diagnostics .warning { color: var(--vscode-editorWarning-foreground); }
	.res { display: grid; grid-template-columns: auto 1fr auto; gap: 6px; align-items: center; }
	.res button, .toolbar button { background: var(--vscode-button-background); color: var(--vscode-button-foreground); border: none; padding: 2px 8px; cursor: pointer; }
	.broken { color: var(--vscode-errorForeground); }
	.toolbar { display: flex; gap: 6px; margin: 8px 0; }
	.banner { border: 1px solid var(--vscode-editorWarning-foreground); padding: 6px; margin: 6px 0; }
	.empty { opacity: 0.7; }
</style>
</head>
<body>
<div id="banner"></div>
<div id="app"><p class="empty">Loading resource…</p></div>
<script>
${WEBVIEW_SCRIPT}
</script>
</body>
</html>`;
}
