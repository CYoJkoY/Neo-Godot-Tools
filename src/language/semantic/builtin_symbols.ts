import { IndexedSymbol } from "../../index/index.js";
import {
	GDScriptBuiltinFunction,
	builtinToSymbol,
	getGDScriptBuiltin,
	getGDScriptBuiltinDocumentationClass,
	getGDScriptBuiltins,
} from "./gdscript_builtins";

export interface ResolvedBuiltinSymbol {
	builtin: GDScriptBuiltinFunction;
	symbol: IndexedSymbol;
	documentationClass: "@GlobalScope" | "@GDScript";
}

export function resolveBuiltinSymbol(name: string): ResolvedBuiltinSymbol | undefined {
	const builtin = getGDScriptBuiltin(name);
	if (!builtin) return undefined;
	return {
		builtin,
		symbol: builtinToSymbol(builtin),
		documentationClass: getGDScriptBuiltinDocumentationClass(name),
	};
}

export function resolveBuiltinSymbols(prefix = ""): readonly ResolvedBuiltinSymbol[] {
	return getGDScriptBuiltins(prefix).map((builtin) => ({
		builtin,
		symbol: builtinToSymbol(builtin),
		documentationClass: getGDScriptBuiltinDocumentationClass(builtin.name),
	}));
}

export function isBuiltinSymbol(symbol: IndexedSymbol): boolean {
	return symbol.uri.startsWith("gdscript://builtin/@GlobalScope/") || symbol.uri.startsWith("gdscript://builtin/@GDScript/");
}
