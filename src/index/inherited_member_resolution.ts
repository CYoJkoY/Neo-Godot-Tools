import { GDScriptDeclaration } from "../analyzer/index.js";
import { FileIndex } from "./file_index.js";
import { IndexedSymbol } from "./symbol.js";
import { SymbolIndex } from "./symbol_index.js";

function normalizeScriptReference(value: string): string {
	const trimmed = value.trim();
	const unquoted = ((trimmed.startsWith("\"") && trimmed.endsWith("\"")) || (trimmed.startsWith("'") && trimmed.endsWith("'")))
		? trimmed.slice(1, -1)
		: trimmed;
	return unquoted.replace(/\\/g, "/");
}

export class InheritedMemberResolver {
	constructor(private readonly files: FileIndex, private readonly symbols: SymbolIndex) {}

	resolve(uri: string, name: string): IndexedSymbol | undefined {
		return this.resolveInHierarchy(uri, name, new Set<string>());
	}

	private resolveInHierarchy(uri: string, name: string, visited: Set<string>): IndexedSymbol | undefined {
		if (visited.has(uri)) return undefined;
		visited.add(uri);

		const file = this.files.get(uri);
		if (!file) return undefined;

		const own = file.symbols.find((symbol) => symbol.kind === "function" && !symbol.containerName && symbol.name === name);
		if (own) return own;

		const base = this.resolveBase(file.ast.declarations);
		return base?.uri ? this.resolveInHierarchy(base.uri, name, visited) : undefined;
	}

	private resolveBase(declarations: GDScriptDeclaration[]): { uri: string } | undefined {
		const declaration = declarations.find((item) => item.kind === "extends");
		if (!declaration || declaration.kind !== "extends") return undefined;

		const reference = normalizeScriptReference(declaration.name);
		if (reference.startsWith("res://") || reference.endsWith(".gd")) return this.resolveScriptPath(reference);

		const matches = this.symbols.find(reference).filter((symbol) =>
			(symbol.kind === "class_name" || symbol.kind === "class") && !symbol.containerName,
		);
		if (matches.length !== 1) return undefined;
		return { uri: matches[0].uri };
	}

	private resolveScriptPath(value: string): { uri: string } | undefined {
		const path = normalizeScriptReference(value).replace(/^res:\/\//, "").replace(/^\/+/, "");
		const matches = [...this.files.values()].filter((file) => {
			try {
				return decodeURIComponent(new URL(file.uri).pathname).replace(/^\/+/, "").endsWith(path);
			} catch {
				return file.uri.endsWith(path);
			}
		});
		return matches.length === 1 ? { uri: matches[0].uri } : undefined;
	}
}
