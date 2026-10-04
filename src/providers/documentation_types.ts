import type { DocumentSymbol } from "vscode-languageclient";

export interface NativeSymbolInspectParams {
	native_class: string;
	symbol_name: string;
}

/**
 * A class or member as reported by `textDocument/nativeSymbol`.
 *
 * Declared as an interface: the value comes from the Godot language server, so
 * there is no constructor to run — it is parsed from the protocol response.
 */
export interface GodotNativeSymbol extends DocumentSymbol {
	documentation?: string;
	native_class?: string;
	class_info?: GodotNativeClassInfo;
}

export interface GodotNativeClassInfo {
	name: string;
	inherits: string;
	extended_classes?: string[];
}

export interface GodotCapabilities {
	native_classes: GodotNativeClassInfo[];
}
