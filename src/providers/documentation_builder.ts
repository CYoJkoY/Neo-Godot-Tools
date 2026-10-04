import { marked } from "marked";
import * as Prism from "prismjs";
import * as csharp from "prismjs/components/prism-csharp";
import * as vscode from "vscode";
import { SymbolKind } from "vscode-languageclient";
import { get_extension_uri } from "../utils";
import { doc_symbol_anchor } from "../utils/doc_anchor";
import type { GodotNativeSymbol } from "./documentation_types";
import yabbcode = require("ya-bbcode");

const parser = new yabbcode();

// The C# grammar is only registered with Prism once its module has been touched.
void csharp;

marked.setOptions({
	highlight: (code, lang) => {
		if (lang === "gdscript") return Prism.highlight(code, GDScriptGrammar, lang);
		if (lang === "csharp") return Prism.highlight(code, Prism.languages["csharp"], lang);
		return code;
	},
});

// TODO: find a better way to apply this theming
const theme_options: Partial<Record<vscode.ColorThemeKind, string>> = {
	[vscode.ColorThemeKind.Dark]: `{
		viewport: null,
		styles: {
			'header,footer,section,article': '#d4d4d480',
			'h1,a': '#d4d4d480',
			'h2,h3,h4': '#d4d4d480'
		},
		back: 'rgba(1,1,1,0.08)',
		view: '#79797933',
		drag: '#bfbfbf33',
		interval: 50
	}`,
	[vscode.ColorThemeKind.Light]: `{
		viewport: null,
		styles: {
			'header,footer,section,article': 'rgba(0,0,0,0.08)',
			'h1,a': 'rgba(0,0,0,0.10)',
			'h2,h3,h4': 'rgba(0,0,0,0.08)'
		},
		back: 'rgba(0,0,0,0.08)',
		view: 'rgba(0,0,0,0.08)',
		drag: 'rgba(0,0,0,0.08)',
		interval: 50
	}`,
};
/** Pagemap options for the current theme; empty for the high-contrast themes. */
const options = theme_options[vscode.window.activeColorTheme.kind] ?? "";

/**
 * Scrolls the documentation page to a symbol. Anchors are kind-prefixed
 * (`method-abs`), so the lookup also falls back to plain names and to the
 * `data-symbol` attributes for pages generated before the anchors existed.
 */
export const DOC_FOCUS_FUNCTION = `function ngdtFocus(target){
  if (!target) return;
  var PREFIXES = ["method","constant","property","signal","enum","constructor","operator","annotation","theme-item"];
  function strip(raw){
    var s = String(raw || "");
    for (var i = 0; i < PREFIXES.length; i++) {
      var p = PREFIXES[i] + "-";
      if (s.slice(0, p.length).toLowerCase() === p) return s.slice(p.length);
    }
    return s;
  }
  function candidates(raw){
    var out = [];
    var name = strip(raw);
    var push = function(v){ if (v && out.indexOf(v) === -1) out.push(v); };
    push(raw); push(raw.toLowerCase());
    if (name) {
      for (var i = 0; i < PREFIXES.length; i++) push(PREFIXES[i] + "-" + name);
      for (var j = 0; j < PREFIXES.length; j++) push(PREFIXES[j] + "-" + name.toLowerCase());
    }
    return out;
  }
  function focus(el){
    el.scrollIntoView({ block: "start", inline: "nearest" });
    el.classList && el.classList.add("ngdt-doc-target");
    if (el.style) {
      el.style.outline = "2px solid #f0a35e";
      el.style.outlineOffset = "2px";
      el.style.borderRadius = "4px";
    }
  }
  var ids = candidates(target);
  for (var i = 0; i < ids.length; i++) {
    var el = document.getElementById(ids[i]);
    if (el) { focus(el); return; }
  }
  var name = strip(target);
  var attrs = ["data-symbol","data-symbol-name","data-name","name","data-member","data-anchor"];
  for (var a = 0; a < attrs.length; a++) {
    var nodes = document.querySelectorAll("[" + attrs[a] + "]");
    for (var n = 0; n < nodes.length; n++) {
      var v = nodes[n].getAttribute(attrs[a]) || "";
      if (v === name || v.toLowerCase() === name.toLowerCase() || v === target) { focus(nodes[n]); return; }
    }
  }
  var heads = document.querySelectorAll("h1,h2,h3,h4,h5,dt,summary,.symbol,.member,.method,.constant");
  for (var h = 0; h < heads.length; h++) {
    var text = (heads[h].textContent || "").trim();
    if (text === name || text === name + "()" || text.replace(/\\(\\)$/, "") === name) { focus(heads[h]); return; }
  }
  window.scrollTo(0, 0);
}`;

/** Maps a native symbol kind onto the documentation anchor prefix. */
function symbol_doc_kind(kind: SymbolKind | undefined): string {
	switch (kind) {
		case SymbolKind.Method:
		case SymbolKind.Function:
			return "method";
		case SymbolKind.Constructor:
			return "constructor";
		case SymbolKind.Operator:
			return "operator";
		case SymbolKind.Property:
		case SymbolKind.Variable:
			return "property";
		case SymbolKind.Constant:
		case SymbolKind.EnumMember:
			return "constant";
		case SymbolKind.Event:
			return "signal";
		case SymbolKind.Enum:
			return "enum";
		default:
			return "method";
	}
}

/** Element id / navigation anchor of a native symbol, e.g. `method-abs`. */
function symbol_element_id(symbol: GodotNativeSymbol): string {
	return doc_symbol_anchor(symbol_doc_kind(symbol.kind), symbol.name);
}

export function make_html_content(webview: vscode.Webview, symbol: GodotNativeSymbol, target?: string): string {
	const pagemapJsUri = webview.asWebviewUri(get_extension_uri("media", "pagemap.js"));
	const prismCssUri = webview.asWebviewUri(get_extension_uri("media", "prism.css"));
	const docsCssUri = webview.asWebviewUri(get_extension_uri("media", "docs.css"));

	const initialFocus = target
		? `
			window.addEventListener('load', event => {
				ngdtFocus(${JSON.stringify(target)});
			});
		`
		: "";

	return /*html*/ `<!DOCTYPE html>
		<html>
		<head>
			<meta name="viewport" content="width=device-width, initial-scale=1.0">
			<link href="${docsCssUri}" rel="stylesheet">
			<link href="${prismCssUri}" rel="stylesheet">

			<title>${symbol.name}</title>
		</head>
		<body style="line-height: scaleFactor%; font-size: scaleFactor%; margin-right: bodyMargin">
			<main>
				${make_symbol_document(symbol)}
			</main>

			<canvas id='minimap' style="display: displayMinimap"></canvas>
			
			<script src="${pagemapJsUri}"></script>
			<script>
				${DOC_FOCUS_FUNCTION}
				pagemap(document.querySelector('#minimap'), ${options});			
				${initialFocus};

				var vscode = acquireVsCodeApi();
				function inspect(native_class, symbol_name) {
					if (typeof (godot_class) != 'undefined' && godot_class == native_class) {
						ngdtFocus(symbol_name);
					} else {
						vscode.postMessage({
							type: 'INSPECT_NATIVE_SYMBOL',
							data: {
								native_class: native_class,
								symbol_name: symbol_name
							}
						});
					}
				};
				window.addEventListener('message', event => {
					const message = event.data;
					switch (message.command) {
						case 'focus':
							ngdtFocus(message.target);
							break;
					}
				});
			</script>
		</body>
		</html>`;
}

export function make_symbol_document(symbol: GodotNativeSymbol): string {
	const classlink = make_link(symbol.native_class, undefined);
	return symbol.kind === SymbolKind.Class
		? make_class_document(symbol, classlink)
		: make_member_document(symbol, classlink);
}

/** Signature line of a function-like member, linking the return type and name. */
function make_function_signature(s: GodotNativeSymbol, classlink: string, with_class = false): string {
	const parts = /\((.*)?\)\s*\-\>\s*(([A-z0-9]+)?)$/.exec(s.detail ?? "");
	if (!parts) return "";
	const ret_type = make_link(parts[2] || "void", undefined);
	const args = (parts[1] || "")
		.replace(/\:\s([A-z0-9_]+)(\,\s*)?/g, ': <a href="" onclick="inspect(\'$1\')">$1</a>$2')
		.replace(/\s=\s(.*?)[\,\)]/g, "");
	return `${ret_type} ${with_class ? `${classlink}.` : ""}${element("a", s.name, {
		href: `#${symbol_element_id(s)}`,
	})}( ${args} )`;
}

/** Index entry and body of one native member, by kind. */
function make_symbol_elements(
	s: GodotNativeSymbol,
	classlink: string,
	with_class = false,
): { index?: string; body: string } {
	switch (s.kind) {
		case SymbolKind.Property:
		case SymbolKind.Variable: {
			// var Control.anchor_left: float
			const parts = /\.([A-z_0-9]+)\:\s(.*)$/.exec(s.detail ?? "");
			if (!parts) return { body: "" };
			const type = make_link(parts[2], undefined);
			const name = element("a", s.name, { href: `#${symbol_element_id(s)}` });
			const title = element("h4", `${type} ${with_class ? `${classlink}.` : ""}${s.name}`);
			return {
				index: `${type} ${name}`,
				body: element("div", title + element("p", format_documentation(s.documentation, s.native_class))),
			};
		}
		case SymbolKind.Constant: {
			// const Control.FOCUS_ALL: FocusMode = 2
			// const Control.NOTIFICATION_RESIZED = 40
			const parts = /\.([A-Za-z_0-9]+)(\:\s*)?([A-z0-9_\.]+)?\s*=\s*(.*)$/.exec(s.detail ?? "");
			if (!parts) return { body: "" };
			const type = make_link(parts[3] || "int", undefined);
			const value = element("code", parts[4]);
			const title = element("p", `${type} ${with_class ? `${classlink}.` : ""}${parts[1]} = ${value}`);
			return {
				body: element("div", title + element("p", format_documentation(s.documentation, s.native_class))),
			};
		}
		case SymbolKind.Event: {
			const parts = /\.([A-z0-9]+)\((.*)?\)/.exec(s.detail ?? "");
			if (!parts) return { body: "" };
			const args = (parts[2] || "").replace(
				/\:\s([A-z0-9_]+)(\,\s*)?/g,
				': <a href="" onclick="inspect(\'$1\')">$1</a>$2',
			);
			const prefix = with_class ? "signal " : "";
			const title = element("p", `${prefix}${with_class ? `${classlink}.` : ""}${s.name}( ${args} )`);
			return {
				body: element("div", title + element("p", format_documentation(s.documentation, s.native_class))),
			};
		}
		case SymbolKind.Method:
		case SymbolKind.Function:
		case SymbolKind.Constructor:
		case SymbolKind.Operator: {
			const signature = make_function_signature(s, classlink, with_class);
			const title = element("h4", signature);
			return {
				index: signature,
				body: element("div", title + element("p", format_documentation(s.documentation, s.native_class))),
			};
		}
		default:
			return { body: "" };
	}
}

/** Member kinds of a class page, in the order the sections are emitted. */
const MEMBER_SECTIONS = [
	{ key: "properties", title: "Properties", index: true, kinds: [SymbolKind.Property, SymbolKind.Variable] },
	{ key: "constructors", title: "Constructors", index: true, kinds: [SymbolKind.Constructor] },
	{ key: "methods", title: "Methods", index: true, kinds: [SymbolKind.Method, SymbolKind.Function] },
	{ key: "operators", title: "Operators", index: true, kinds: [SymbolKind.Operator] },
	{ key: "signals", title: "Signals", index: false, kinds: [SymbolKind.Event] },
	{ key: "constants", title: "Constants", index: false, kinds: [SymbolKind.Constant] },
] as const;

const DESCRIPTION_SECTIONS = [
	["properties", "Property Descriptions"],
	["constructors", "Constructor Descriptions"],
	["methods", "Method Descriptions"],
	["operators", "Operator Descriptions"],
] as const;

const OTHER_SECTION = "others";

/** Section key of a member kind; everything unknown lands under "Other Members". */
function section_of(kind: SymbolKind | undefined): string {
	return (
		MEMBER_SECTIONS.find((section) => (section.kinds as readonly SymbolKind[]).includes(kind as SymbolKind))?.key ??
		OTHER_SECTION
	);
}

function make_class_document(symbol: GodotNativeSymbol, classlink: string): string {
	// Two lists per section: the anchor index at the top, the descriptions below.
	const index: Record<string, string[]> = {};
	const body: Record<string, string[]> = {};
	const push = (groups: Record<string, string[]>, key: string, item: string): void => {
		groups[key] = [...(groups[key] ?? []), item];
	};

	const extended = symbol.class_info?.extended_classes;
	const inheritance = [
		symbol.class_info?.inherits
			? element("p", `Inherits: ${make_link(symbol.class_info.inherits, undefined)}`)
			: "",
		// The line is emitted whenever the array is present, and its first entry is
		// prefixed with a space: `Inherited by: A, B`.
		extended
			? element(
					"p",
					`Inherited by:${extended.map((name, index) => `${index ? ", " : " "}${make_link(name, name)}`).join("")}`,
				)
			: "",
	].join("");

	((symbol.children ?? []) as GodotNativeSymbol[]).map((child) => {
		const key = section_of(child.kind);
		const elements = make_symbol_elements(child, classlink);
		const attributes = { id: symbol_element_id(child), "data-symbol": child.name };
		if (MEMBER_SECTIONS.some((section) => section.key === key && section.index))
			push(index, key, element("li", elements.index ?? ""));
		push(body, key, element("li", elements.body, attributes));
	});

	const add_group = (title: string, block: string): string =>
		block ? element("h3", title) + element("ul", block) : "";
	const list = (groups: Record<string, string[]>): Record<string, string> =>
		Object.fromEntries(Object.entries(groups).map(([key, items]) => [key, items.join("")]));

	const indexes = list(index);
	const bodies = list(body);
	const sections = MEMBER_SECTIONS.map((section) =>
		add_group(section.title, section.index ? (indexes[section.key] ?? "") : (bodies[section.key] ?? "")),
	).join("");
	const descriptions = DESCRIPTION_SECTIONS.map(([key, title]) => add_group(title, bodies[key] ?? "")).join("");

	return [
		element("h2", `Class: ${symbol.name}`),
		inheritance,
		element("p", format_documentation(symbol.documentation, symbol.native_class)),
		sections,
		descriptions,
		add_group("Other Members", bodies[OTHER_SECTION] ?? ""),
		element("script", `var godot_class = "${symbol.native_class}";`),
	].join("");
}

function make_member_document(symbol: GodotNativeSymbol, classlink: string): string {
	const elements = make_symbol_elements(symbol, classlink, true);
	const is_callable = symbol.kind === SymbolKind.Function || symbol.kind === SymbolKind.Method;
	const heading = elements.index && !is_callable ? element("h2", elements.index) : "";
	return heading + element("div", elements.body);
}

function element<K extends keyof HTMLElementTagNameMap>(
	tag: K,
	content: string,
	props: Record<string, string | number | undefined> = {},
	new_line?: boolean,
	indent?: string,
) {
	// Attribute order follows insertion order, which keeps the generated HTML
	// stable between runs (the panel is a cache key for the webview).
	const attributes = Object.entries(props).filter(([, value]) => value !== undefined);
	const props_str = attributes.map(([key, value]) => ` ${key}="${value}"`).join("");
	return `${indent || ""}<${tag} ${props_str}>${content}</${tag}>${new_line ? "\n" : ""}`;
}

function make_link(classname: string | undefined, symbol: string | undefined) {
	if (!classname) return "";
	if (!symbol || symbol === classname) {
		return element("a", classname, {
			onclick: `inspect('${classname}')`,
			href: "",
		});
	}
	return element("a", `${classname}.${symbol}`, {
		onclick: `inspect('${classname}', '${symbol}')`,
		href: "",
	});
}

function make_codeblock(code: string, language: string) {
	const lines = code.split("\n");
	const indent = lines[0].match(/^\s*/)?.[0].length;
	const _code = lines.map((line) => line.slice(indent)).join("\n");
	return marked.parse(`\`\`\`${language}\n${_code}\n\`\`\``);
}

/**
 * Renders every `[<tag>]…[/<tag>]` block of `html` as a highlighted code block.
 *
 * `replaceAll` with a replacer function (instead of `replace` with a string)
 * keeps `$&`, `` $` `` and `$'` inside the code literal - GDScript documentation
 * uses `$NodePath`, and a string replacement would interpret those sequences.
 */
function highlight_blocks(html: string, tag: string, language: string): string {
	const block_pattern = new RegExp(`\\[${tag}].*?\\[\\/${tag}]`, "gs");
	const marker_pattern = new RegExp(`\\[\\/?${tag}\\](<br\\/>)?`, "g");
	return html.replaceAll(block_pattern, (block) =>
		make_codeblock(block.replaceAll(marker_pattern, "").replaceAll("<br/>", "\n"), language),
	);
}

function format_documentation(bbcode: string | undefined, classname: string | undefined) {
	// ya-bbcode doesn't parse [code skip-lint] as a [code] tag
	const parsed = parser.parse((bbcode ?? "").replaceAll("[code skip-lint]", "[code]").trim());
	// Code blocks first: their content is already HTML and must not be re-scanned
	// by the reference patterns below.
	const code = (["codeblock", "gdscript", "csharp"] as const).reduce(
		(html, tag) => highlight_blocks(html, tag, tag === "csharp" ? "csharp" : "gdscript"),
		parsed.replaceAll(/\[\/?codeblocks\](<br\/>)?/g, "").replaceAll("&quot;", '"'),
	);
	const reference_patterns: Array<[RegExp, string]> = [
		// [param <name>]
		[/\[param\s+(@?[A-Z_a-z][A-Z_a-z0-9]*?)\]/g, "<code>$1</code>"],
		// [method <name>]
		[/\[method\s+(@?[A-Z_a-z][A-Z_a-z0-9]*?)\]/g, `<a href="" onclick="inspect('${classname}', '$1')">$1</a>`],
		// [<reference>]
		[/\[(\w+)\]/g, `<a href="" onclick="inspect('$1')">$1</a>`],
		// [method <class>.<name>]
		[/\[\w+\s+(@?[A-Z_a-z][A-Z_a-z0-9]*?)\.(\w+)\]/g, `<a href="" onclick="inspect('$1', '$2')">$1.$2</a>`],
	];
	return reference_patterns.reduce(
		(html, [pattern, replacement]) => html.replaceAll(pattern, replacement),
		code.replaceAll("<br/>		", ""),
	);
}

const GDScriptGrammar = {
	comment: {
		pattern: /(^|[^\\])#.*/,
		lookbehind: true,
	},
	"string-interpolation": {
		pattern: /(?:f|rf|fr)(?:("""|''')[\s\S]+?\1|("|')(?:\\.|(?!\2)[^\\\r\n])*\2)/i,
		greedy: true,
		inside: {
			interpolation: {
				// "{" <expression> <optional "!s", "!r", or "!a"> <optional ":" format specifier> "}"
				pattern: /((?:^|[^{])(?:{{)*){(?!{)(?:[^{}]|{(?!{)(?:[^{}]|{(?!{)(?:[^{}])+})+})+}/,
				lookbehind: true,
				inside: {
					"format-spec": {
						pattern: /(:)[^:(){}]+(?=}$)/,
						lookbehind: true,
					},
					"conversion-option": {
						pattern: /![sra](?=[:}]$)/,
						alias: "punctuation",
					},
					rest: null,
				},
			},
			string: /[\s\S]+/,
		},
	},
	"triple-quoted-string": {
		pattern: /(?:[rub]|rb|br)?("""|''')[\s\S]+?\1/i,
		greedy: true,
		alias: "string",
	},
	string: {
		pattern: /(?:[rub]|rb|br)?("|')(?:\\.|(?!\1)[^\\\r\n])*\1/i,
		greedy: true,
	},
	function: {
		pattern: /((?:^|\s)func[ \t]+)[a-zA-Z_]\w*(?=\s*\()/g,
		lookbehind: true,
	},
	"class-name": {
		pattern: /(\bclass\s+)\w+/i,
		lookbehind: true,
	},
	decorator: {
		pattern: /(^\s*)@\w+(?:\.\w+)*/im,
		lookbehind: true,
		alias: ["annotation", "punctuation"],
		inside: {
			punctuation: /\./,
		},
	},
	keyword:
		/\b(?:if|elif|else|for|while|break|continue|pass|return|match|func|class|class_name|extends|is|onready|tool|static|export|setget|const|var|as|void|enum|preload|assert|yield|signal|breakpoint|rpc|sync|master|puppet|slave|remotesync|mastersync|puppetsync)\b/,
	builtin:
		/\b(?:PI|TAU|NAN|INF|_|sin|cos|tan|sinh|cosh|tanh|asin|acos|atan|atan2|sqrt|fmod|fposmod|floor|ceil|round|abs|sign|pow|log|exp|is_nan|is_inf|ease|decimals|stepify|lerp|dectime|randomize|randi|randf|rand_range|seed|rand_seed|deg2rad|rad2deg|linear2db|db2linear|max|min|clamp|nearest_po2|weakref|funcref|convert|typeof|type_exists|char|str|print|printt|prints|printerr|printraw|var2str|str2var|var2bytes|bytes2var|range|load|inst2dict|dict2inst|hash|Color8|print_stack|instance_from_id|preload|yield|assert|Vector2|Vector3|Color|Rect2|Array|Basis|Dictionary|Plane|Quat|RID|Rect3|Transform|Transform2D|AABB|String|Color|NodePath|RID|Object|Dictionary|Array|PoolByteArray|PoolIntArray|PoolRealArray|PoolStringArray|PoolVector2Array|PoolVector3Array|PoolColorArray)\b/,
	boolean: /\b(?:true|false)\b/,
	number: /(?:\b(?=\d)|\B(?=\.))(?:0[bo])?(?:(?:\d|0x[\da-f])[\da-f]*\.?\d*|\.\d+)(?:e[+-]?\d+)?j?\b/i,
	operator: /[-+%=]=?|!=|\*\*?=?|\/\/?=?|<[<=>]?|>[=>]?|[&|^~]/,
	punctuation: /[{}[\];(),.:]/,
};
