import { GDScriptDeclaration } from "../../analyzer/index.js";
import { Binding, BindingIndex, FileIndex, IndexedSymbol, SymbolIndex, TypeResolutionIndex, ResolvedType } from "../../index/index.js";
import { InheritedMemberResolver } from "../../index/inherited_member_resolution.js";
import { resolveBuiltinSymbol, resolveBuiltinSymbols } from "./builtin_symbols.js";

export type ResolutionConfidence = "exact" | "inferred" | "partial" | "unknown";

export interface ResolutionResult<T> {
	value?: T;
	confidence: ResolutionConfidence;
}

export interface SemanticPosition {
	offset: number;
}

export interface SemanticCompletionItem {
	name: string;
	kind: Binding["kind"] | IndexedSymbol["kind"];
	type?: string;
	returnType?: string;
	containerName?: string;
	uri: string;
}

interface QueryDependencySnapshot {
	files: ReadonlyMap<string, string>;
	symbolQueries: ReadonlyMap<string, string>;
	workspaceQueries: ReadonlyMap<string, string>;
}

interface CacheEntry<T> {
	dependencies: QueryDependencySnapshot;
	result: T;
}

function wordAt(source: string, offset: number): { name: string; start: number; end: number } | undefined {
	const clamped = Math.max(0, Math.min(offset, source.length));
	let start = clamped;
	while (start > 0 && /[A-Za-z0-9_]/.test(source[start - 1])) start--;
	let end = clamped;
	while (end < source.length && /[A-Za-z0-9_]/.test(source[end])) end++;
	const name = source.slice(start, end);
	return /^[A-Za-z_][A-Za-z0-9_]*$/.test(name) ? { name, start, end } : undefined;
}

function findContainingFunctionName(declarations: GDScriptDeclaration[], offset: number): string | undefined {
	for (const declaration of declarations) {
		if (declaration.kind === "function" && declaration.bodyRange && declaration.bodyRange.start.offset <= offset && offset <= declaration.bodyRange.end.offset) {
			return declaration.name;
		}
		if (declaration.kind === "class") {
			const nested = findContainingFunctionName(declaration.declarations, offset);
			if (nested) return nested;
		}
	}
	return undefined;
}

function symbolFromBinding(binding: Binding): IndexedSymbol {
	return {
		name: binding.name,
		kind: binding.kind === "member" || binding.kind === "local" || binding.kind === "parameter" ? "variable" : binding.kind,
		uri: binding.uri,
		range: binding.declarationRange,
		type: binding.type,
		returnType: binding.returnType,
		containerName: binding.containerName,
	};
}

function completionFromSymbol(symbol: IndexedSymbol): SemanticCompletionItem {
	return {
		name: symbol.name,
		kind: symbol.kind,
		type: symbol.type,
		returnType: symbol.returnType,
		containerName: symbol.containerName,
		uri: symbol.uri,
	};
}

export class SemanticQueryEngine {
	private readonly symbolCache = new Map<string, CacheEntry<ResolutionResult<IndexedSymbol>>>();
	private readonly completionCache = new Map<string, CacheEntry<ResolutionResult<readonly SemanticCompletionItem[]>>>();
	private readonly inheritedMembers: InheritedMemberResolver;

	constructor(
		private readonly files: FileIndex,
		private readonly symbols: SymbolIndex,
		private readonly bindings: BindingIndex,
		private readonly types: TypeResolutionIndex,
	) {
		this.inheritedMembers = new InheritedMemberResolver(files, symbols);
	}

	getSymbol(uri: string, position: SemanticPosition): ResolutionResult<IndexedSymbol> {
		const key = `${uri}:${position.offset}`;
		const cached = this.symbolCache.get(key);
		if (cached && this.dependenciesValid(cached.dependencies)) return cached.result;
		const result = this.resolveSymbol(uri, position);
		this.symbolCache.set(key, { dependencies: this.captureSymbolDependencies(uri, position), result });
		return result;
	}

	getDefinition(uri: string, position: SemanticPosition): ResolutionResult<IndexedSymbol> {
		return this.getSymbol(uri, position);
	}

	getHover(uri: string, position: SemanticPosition): ResolutionResult<IndexedSymbol> {
		return this.getSymbol(uri, position);
	}

	getReferences(uri: string, position: SemanticPosition, includeDeclaration: boolean): ResolutionResult<ReturnType<BindingIndex["findReferences"]>> {
		const file = this.files.get(uri);
		if (!file) return { confidence: "unknown" };
		const word = wordAt(file.source, position.offset);
		if (!word) return { confidence: "unknown" };
		const binding = this.bindings.getBinding(uri, word.start, word.name);
		if (!binding) return { confidence: "unknown" };
		const references = this.bindings.findReferences(binding.id).filter((reference) => {
			if (includeDeclaration) return true;
			return reference.uri !== binding.uri || reference.range.start.offset !== binding.declarationRange.start.offset;
		});
		return { value: references, confidence: "exact" };
	}

	getCompletions(uri: string, position: SemanticPosition): ResolutionResult<readonly SemanticCompletionItem[]> {
		const key = `${uri}:${position.offset}`;
		const cached = this.completionCache.get(key);
		if (cached && this.dependenciesValid(cached.dependencies)) return cached.result;
		const result = this.resolveCompletions(uri, position);
		this.completionCache.set(key, { dependencies: this.captureCompletionDependencies(uri, position), result });
		return result;
	}

	getType(uri: string, position: SemanticPosition, expression?: string): ResolutionResult<ResolvedType> {
		const file = this.files.get(uri);
		if (!file) return { confidence: "unknown" };
		const source = file.source;
		const word = wordAt(source, position.offset);
		const value = expression ?? word?.name;
		if (!value) return { confidence: "unknown" };

		const receiver = this.types.resolveReceiver(uri, position.offset, value);
		if (receiver) return { value: receiver, confidence: receiver.builtin ? "inferred" : "exact" };
		const named = this.types.resolveName(value);
		if (named) return { value: named, confidence: named.builtin ? "inferred" : "exact" };
		return { confidence: "unknown" };
	}

	getMembers(type: ResolvedType): ResolutionResult<readonly IndexedSymbol[]> {
		if (type.builtin || !type.uri) return { confidence: "unknown" };
		const members = this.types.getMembers(type);
		if (!members.length) return { confidence: "unknown" };
		return { value: members, confidence: "exact" };
	}

	invalidate(uris: Iterable<string>): void {
		const affected = new Set(uris);
		if (!affected.size) return;
		for (const [key, entry] of this.symbolCache) {
			if ([...entry.dependencies.files.keys()].some((uri) => affected.has(uri))) this.symbolCache.delete(key);
		}
		for (const [key, entry] of this.completionCache) {
			if ([...entry.dependencies.files.keys()].some((uri) => affected.has(uri))) this.completionCache.delete(key);
		}
	}

	clear(): void {
		this.symbolCache.clear();
		this.completionCache.clear();
	}

	private captureSymbolDependencies(uri: string, position: SemanticPosition): QueryDependencySnapshot {
		const files = new Map<string, string>();
		this.captureFile(files, uri);
		const file = this.files.get(uri);
		const word = file ? wordAt(file.source, position.offset) : undefined;
		const symbolQueries = new Map<string, string>();
		if (word) symbolQueries.set(word.name, this.symbols.signature(word.name));
		const memberReceiver = this.memberReceiver(file, word);
		if (memberReceiver) {
			symbolQueries.set(memberReceiver.name, this.symbols.signature(memberReceiver.name));
			const receiver = this.types.resolveReceiver(uri, word!.start, memberReceiver.name);
			if (receiver?.uri) this.captureFile(files, receiver.uri);
		}
		return { files, symbolQueries, workspaceQueries: new Map() };
	}

	private captureCompletionDependencies(uri: string, position: SemanticPosition): QueryDependencySnapshot {
		const files = new Map<string, string>();
		this.captureFile(files, uri);
		const file = this.files.get(uri);
		const word = file ? wordAt(file.source, position.offset) : undefined;
		const workspaceQueries = new Map<string, string>();
		const memberReceiver = this.memberReceiver(file, word);
		if (memberReceiver) {
			const receiver = this.types.resolveReceiver(uri, word!.start, memberReceiver.name);
			if (receiver?.uri) this.captureFile(files, receiver.uri);
			return { files, symbolQueries: new Map([[memberReceiver.name, this.symbols.signature(memberReceiver.name)]]), workspaceQueries };
		}
		const prefix = word?.name ?? "";
		workspaceQueries.set(prefix, this.symbols.workspaceSignature(prefix));
		return { files, symbolQueries: new Map(), workspaceQueries };
	}

	private memberReceiver(file: ReturnType<FileIndex["get"]>, word: { name: string; start: number; end: number } | undefined): { name: string } | undefined {
		if (!file || !word) return undefined;
		const prefix = file.source.slice(0, word.start);
		const match = prefix.match(/([A-Za-z_]\w*)\.$/);
		if (match) return { name: match[1] };
		if (prefix.endsWith(".")) return { name: "super" };
		return undefined;
	}

	private captureFile(target: Map<string, string>, uri: string): void {
		target.set(uri, this.snapshot(uri));
	}

	private dependenciesValid(dependencies: QueryDependencySnapshot): boolean {
		for (const [uri, snapshot] of dependencies.files) if (this.snapshot(uri) !== snapshot) return false;
		for (const [name, signature] of dependencies.symbolQueries) if (this.symbols.signature(name) !== signature) return false;
		for (const [query, signature] of dependencies.workspaceQueries) if (this.symbols.workspaceSignature(query) !== signature) return false;
		return true;
	}

	private snapshot(uri: string): string {
		const file = this.files.get(uri);
		return file ? `${file.sourceFingerprint}:${file.apiFingerprint}` : "missing";
	}

	private resolveSymbol(uri: string, position: SemanticPosition): ResolutionResult<IndexedSymbol> {
		const file = this.files.get(uri);
		if (!file) return { confidence: "unknown" };
		const source = file.source;
		const word = wordAt(source, position.offset);
		if (!word) return { confidence: "unknown" };

		const prefix = source.slice(0, word.start);
		const after = source.slice(word.end);
		if (word.name === "super" && /^\s*\(/.test(after)) {
			const functionName = findContainingFunctionName(file.ast.declarations, word.start);
			const parent = this.types.resolveReceiver(uri, word.start, "super");
			const member = functionName && parent?.uri ? this.inheritedMembers.resolve(parent.uri, functionName) : undefined;
			if (member) return { value: member, confidence: "exact" };
			if (parent) return { confidence: "partial" };
		}

		const memberMatch = prefix.match(/([A-Za-z_]\w*)\.$/);
		const shorthandMember = !memberMatch && prefix.endsWith(".");
		if (memberMatch || shorthandMember) {
			const receiverName = memberMatch?.[1] ?? "super";
			const receiver = this.types.resolveReceiver(uri, word.start, receiverName);
			const member = receiver ? this.inheritedMembers.resolve(receiver.uri ?? "", word.name) : undefined;
			if (member) return { value: member, confidence: "exact" };
			if (receiver) return { confidence: "partial" };
		}

		const binding = this.bindings.getBinding(uri, word.start, word.name);
		if (binding) return { value: symbolFromBinding(binding), confidence: "exact" };
		const builtin = resolveBuiltinSymbol(word.name);
		if (builtin) return { value: builtin.symbol, confidence: "exact" };
		const localSymbols = file.symbols.filter((symbol) => symbol.name === word.name);
		if (localSymbols.length === 1) return { value: localSymbols[0], confidence: "inferred" };
		const workspaceSymbols = this.symbols.find(word.name);
		if (workspaceSymbols.length === 1) return { value: workspaceSymbols[0], confidence: "inferred" };
		if (localSymbols.length > 1 || workspaceSymbols.length > 1) return { confidence: "partial" };
		return { confidence: "unknown" };
	}

	private resolveCompletions(uri: string, position: SemanticPosition): ResolutionResult<readonly SemanticCompletionItem[]> {
		const file = this.files.get(uri);
		if (!file) return { confidence: "unknown" };
		const source = file.source;
		const word = wordAt(source, position.offset);
		const wordStart = word?.start ?? position.offset;
		const prefix = source.slice(0, wordStart);
		const memberMatch = prefix.match(/(?:^|[^A-Za-z0-9_])([A-Za-z_]\w*)\.$/);
		if (memberMatch) {
			const receiver = this.types.resolveReceiver(uri, wordStart, memberMatch[1]);
			if (!receiver || receiver.builtin) return { confidence: "unknown" };
			const members = this.types.getMembers(receiver);
			if (!members.length) return { confidence: "unknown" };
			const memberPrefix = word?.name ?? "";
			return {
				value: members.filter((member) => member.name.startsWith(memberPrefix)).map(completionFromSymbol),
				confidence: "exact",
			};
		}
		if (prefix.endsWith(".")) {
			const receiver = this.types.resolveReceiver(uri, wordStart, "super");
			if (!receiver || receiver.builtin) return { confidence: "unknown" };
			const members = this.types.getMembers(receiver);
			if (!members.length) return { confidence: "unknown" };
			const memberPrefix = word?.name ?? "";
			return {
				value: members.filter((member) => member.name.startsWith(memberPrefix)).map(completionFromSymbol),
				confidence: "exact",
			};
		}

		const completionPrefix = word?.name ?? "";
		const bindings = this.bindings.getVisibleBindings(uri, position.offset);
		const localItems = bindings
			.filter((binding) => binding.name.startsWith(completionPrefix))
			.map((binding) => completionFromSymbol(symbolFromBinding(binding)));
		const localNames = new Set(localItems.map((item) => item.name));
		const workspaceItems = this.symbols.workspaceSymbols(completionPrefix)
			.filter((symbol) => !localNames.has(symbol.name))
			.map(completionFromSymbol);
		const builtinItems = resolveBuiltinSymbols(completionPrefix)
			.filter(({ builtin }) => !localNames.has(builtin.name) && !workspaceItems.some((item) => item.name === builtin.name))
			.map(({ symbol }) => completionFromSymbol(symbol));
		const items = [...localItems, ...workspaceItems, ...builtinItems];
		if (!items.length) return { confidence: "unknown" };
		return { value: items, confidence: "exact" };
	}
}
