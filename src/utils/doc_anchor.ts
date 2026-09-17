
export type DocSymbolKind =
	| "method"
	| "constant"
	| "property"
	| "signal"
	| "enum"
	| "constructor"
	| "operator"
	| "annotation"
	| "theme-item";

const ANCHOR_PREFIXES: DocSymbolKind[] = [
	"method",
	"constant",
	"property",
	"signal",
	"enum",
	"constructor",
	"operator",
	"annotation",
	"theme-item",
];

export function doc_symbol_kind(raw: string | undefined): DocSymbolKind {
	switch ((raw ?? "").toLowerCase()) {
		case "constant":
		case "enum_value":
			return "constant";
		case "variable":
		case "member":
		case "property":
			return "property";
		case "signal":
			return "signal";
		case "enum":
			return "enum";
		case "constructor":
			return "constructor";
		case "operator":
			return "operator";
		case "annotation":
			return "annotation";
		case "theme_item":
		case "theme-item":
			return "theme-item";
		default:
			return "method";
	}
}

export function doc_symbol_anchor(kind: DocSymbolKind | string | undefined, name: string): string {
	const prefix =
		typeof kind === "string" && ANCHOR_PREFIXES.includes(kind as DocSymbolKind)
			? (kind as DocSymbolKind)
			: doc_symbol_kind(kind);
	return `${prefix}-${name.trim().toLowerCase()}`;
}

export function doc_anchor_symbol_name(anchor: string): string {
	return anchor.replace(
		/^(?:method|constant|property|signal|enum|constructor|operator|annotation|theme-item)-/i,
		"",
	);
}
