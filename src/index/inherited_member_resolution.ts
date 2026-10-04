import { GDScriptDeclaration } from "../analyzer/index.js";
import { FileIndex } from "./file_index.js";
import { IndexedFile, IndexedSymbol } from "./symbol.js";
import { SymbolIndex } from "./symbol_index.js";

/** Member kinds that can be resolved through `receiver.name` expressions. */
const MEMBER_KINDS = new Set(["variable", "constant", "signal", "function", "enum", "class"]);

function normalizeScriptReference(value: string): string {
	const trimmed = value.trim();
	const unquoted =
		(trimmed.startsWith('"') && trimmed.endsWith('"')) || (trimmed.startsWith("'") && trimmed.endsWith("'"))
			? trimmed.slice(1, -1)
			: trimmed;
	return unquoted.replace(/\\/g, "/");
}

export interface InheritedMemberResolver {
	resolve(uri: string, name: string, containerName?: string): IndexedSymbol | undefined;
	resolveInClass(uri: string, classSymbol: IndexedSymbol, name: string): IndexedSymbol | undefined;
}

export function createInheritedMemberResolver(files: FileIndex, symbols: SymbolIndex): InheritedMemberResolver {
	const resolve = (uri: string, name: string, containerName?: string): IndexedSymbol | undefined => {
		return resolveInHierarchy(uri, name, new Set<string>(), containerName);
	};

	/**
	 * Resolves `name` against a specific class declaration (an inner class or a
	 * `class_name` script), following that class's own `extends` chain.
	 *
	 * Passing the class symbol instead of a name keeps `self.run()` and
	 * `Worker.run()` correct when several nested classes define `run`.
	 */

	const resolveInClass = (uri: string, classSymbol: IndexedSymbol, name: string): IndexedSymbol | undefined => {
		return resolveInClassHierarchy(uri, classSymbol, name, new Set<string>());
	};

	const resolveInClassHierarchy = (
		uri: string,
		classSymbol: IndexedSymbol,
		name: string,
		visited: Set<string>,
	): IndexedSymbol | undefined => {
		const key = `${uri}#${classSymbol.range.start.offset}`;
		if (visited.has(key)) return undefined;
		visited.add(key);

		const file = files.get(uri);
		if (!file) return undefined;

		const own = file.symbols.find(
			(symbol) =>
				MEMBER_KINDS.has(symbol.kind) &&
				symbol.name === name &&
				(belongsToClass(symbol, classSymbol) || belongsToClassByName(file, symbol, classSymbol)),
		);
		if (own) return own;

		const reference = classSymbol.extendsName ? normalizeScriptReference(classSymbol.extendsName) : "";
		if (!reference) return undefined;
		if (reference.startsWith("res://") || reference.endsWith(".gd")) {
			const base = resolveScriptPath(reference);
			return base?.uri ? resolveInHierarchy(base.uri, name, new Set<string>()) : undefined;
		}
		const sameFile = file.symbols.filter((symbol) => symbol.kind === "class" && symbol.name === reference);
		if (sameFile.length === 1) return resolveInClassHierarchy(uri, sameFile[0], name, visited);
		// `class Worker extends Base` where `Base` is a `class_name` script in
		// another file: inherited members live in that script.
		const base = resolveNamedClass(reference);
		if (base) {
			return base.symbol.kind === "class"
				? resolveInClassHierarchy(base.uri, base.symbol, name, visited)
				: resolveInHierarchy(base.uri, name, new Set<string>());
		}
		return resolve(uri, name);
	};

	/** Top-level `class_name`/script class declaration named `reference`. */

	const resolveNamedClass = (reference: string): { uri: string; symbol: IndexedSymbol } | undefined => {
		const matches = symbols
			.find(reference)
			.filter((symbol) => (symbol.kind === "class_name" || symbol.kind === "class") && !symbol.containerName);
		if (matches.length !== 1) return undefined;
		return { uri: matches[0].uri, symbol: matches[0] };
	};

	const belongsToClass = (symbol: IndexedSymbol, classSymbol: IndexedSymbol): boolean => {
		return Boolean(symbol.containerRange) && symbol.containerRange!.start.offset === classSymbol.range.start.offset;
	};

	const belongsToClassByName = (file: IndexedFile, symbol: IndexedSymbol, classSymbol: IndexedSymbol): boolean => {
		// Fallback for symbols built without `containerRange` (older callers or
		// hand-written test fixtures).
		return symbol.uri === file.uri && Boolean(symbol.containerName) && symbol.containerName === classSymbol.name;
	};

	const resolveInHierarchy = (
		uri: string,
		name: string,
		visited: Set<string>,
		containerName?: string,
	): IndexedSymbol | undefined => {
		if (visited.has(uri)) return undefined;
		visited.add(uri);

		const file = files.get(uri);
		if (!file) return undefined;

		const own = file.symbols.find(
			(symbol) =>
				MEMBER_KINDS.has(symbol.kind) &&
				symbol.name === name &&
				(containerName ? symbol.containerName === containerName : !symbol.containerName),
		);
		if (own) return own;

		if (containerName) return undefined;

		const base = resolveBase(file.ast.declarations);
		return base?.uri ? resolveInHierarchy(base.uri, name, visited) : undefined;
	};

	const resolveBase = (declarations: GDScriptDeclaration[]): { uri: string } | undefined => {
		const declaration = declarations.find((item) => item.kind === "extends");
		if (!declaration || declaration.kind !== "extends") return undefined;

		const reference = normalizeScriptReference(declaration.name);
		if (reference.startsWith("res://") || reference.endsWith(".gd")) return resolveScriptPath(reference);

		const matches = symbols
			.find(reference)
			.filter((symbol) => (symbol.kind === "class_name" || symbol.kind === "class") && !symbol.containerName);
		if (matches.length !== 1) return undefined;
		return { uri: matches[0].uri };
	};

	const resolveScriptPath = (value: string): { uri: string } | undefined => {
		const path = normalizeScriptReference(value)
			.replace(/^res:\/\//, "")
			.replace(/^\/+/, "");
		const uri = files.findByPathSuffix(path);
		return uri ? { uri } : undefined;
	};

	return {
		resolve,
		resolveInClass,
	};
}
