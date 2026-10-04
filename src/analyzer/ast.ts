export type GDScriptNodeKind =
	| "script"
	| "class"
	| "class_name"
	| "extends"
	| "signal"
	| "enum"
	| "constant"
	| "variable"
	| "function";

export interface SourcePosition {
	offset: number;
	line: number;
	character: number;
}

export interface SourceRange {
	start: SourcePosition;
	end: SourcePosition;
}

export interface GDScriptNode {
	kind: GDScriptNodeKind;
	name?: string;
	range: SourceRange;
	/**
	 * Offset of the identifier that declares the node.
	 *
	 * `range` starts at the introducing keyword (`var`, `func`, `class`, …), so
	 * it cannot tell a rename where the *name* is. Keeping the offset here avoids
	 * searching the text again for every symbol.
	 */
	nameOffset?: number;
}

export interface GDScriptParameter {
	name: string;
	type?: string;
	defaultValue?: string;
	range: SourceRange;
}

export interface GDScriptScript extends GDScriptNode {
	kind: "script";
	declarations: GDScriptDeclaration[];
}

export interface GDScriptClassName extends GDScriptNode {
	kind: "class_name";
	name: string;
}

export interface GDScriptClass extends GDScriptNode {
	kind: "class";
	name: string;
	extendsName?: string;
	declarations: GDScriptDeclaration[];
}

export interface GDScriptExtends extends GDScriptNode {
	kind: "extends";
	name: string;
}

export interface GDScriptSignal extends GDScriptNode {
	kind: "signal";
	name: string;
	parameters: GDScriptParameter[];
}

export interface GDScriptEnumMember {
	name: string;
	value?: string;
	range: SourceRange;
}

export interface GDScriptEnum extends GDScriptNode {
	kind: "enum";
	name?: string;
	members: GDScriptEnumMember[];
}

export interface GDScriptConstant extends GDScriptNode {
	kind: "constant";
	name: string;
	type?: string;
	value?: string;
}

export interface GDScriptVariable extends GDScriptNode {
	kind: "variable";
	name: string;
	type?: string;
	value?: string;
}

export interface GDScriptFunction extends GDScriptNode {
	kind: "function";
	name: string;
	parameters: GDScriptParameter[];
	returnType?: string;
	static: boolean;
	indent: number;
	bodyRange?: SourceRange;
}

export type GDScriptDeclaration =
	| GDScriptClass
	| GDScriptClassName
	| GDScriptExtends
	| GDScriptSignal
	| GDScriptEnum
	| GDScriptConstant
	| GDScriptVariable
	| GDScriptFunction;

export interface GDScriptDiagnostic {
	message: string;
	range: SourceRange;
	severity: "error" | "warning";
}

export interface GDScriptParseResult {
	ast: GDScriptScript;
	diagnostics: GDScriptDiagnostic[];
}
