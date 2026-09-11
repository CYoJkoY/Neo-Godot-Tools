import { Binding, BindingIndex, FileIndex, IndexedSymbol, SymbolIndex, TypeResolutionIndex, ResolvedType } from "../../index/index.js";

export type ResolutionConfidence = "exact" | "inferred" | "partial" | "unknown";

export interface ResolutionResult<T> {
	value?: T;
	confidence: ResolutionConfidence;
}

export interface SemanticPosition {
	offset: number;
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

export class SemanticQueryEngine {
	constructor(
		private readonly files: FileIndex,
		private readonly symbols: SymbolIndex,
		private readonly bindings: BindingIndex,
		private readonly types: TypeResolutionIndex,
	) {}

	getSymbol(uri: string, position: SemanticPosition): ResolutionResult<IndexedSymbol> {
		const file = this.files.get(uri);
		if (!file) return { confidence: "unknown" };
		const source = file.source;
		const word = wordAt(source, position.offset);
		if (!word) return { confidence: "unknown" };

		const prefix = source.slice(0, word.start);
		const memberMatch = prefix.match(/([A-Za-z_]\w*)\.$/);
		if (memberMatch) {
			const receiver = this.types.resolveReceiver(uri, word.start, memberMatch[1]);
			const member = receiver ? this.types.getMember(receiver, word.name) : undefined;
			if (member) return { value: member, confidence: "exact" };
			if (receiver) return { confidence: "partial" };
		}

		const binding = this.bindings.getBinding(uri, word.start, word.name);
		if (binding) return { value: symbolFromBinding(binding), confidence: "exact" };
		const localSymbols = file.symbols.filter((symbol) => symbol.name === word.name);
		if (localSymbols.length === 1) return { value: localSymbols[0], confidence: "inferred" };
		const workspaceSymbols = this.symbols.find(word.name);
		if (workspaceSymbols.length === 1) return { value: workspaceSymbols[0], confidence: "inferred" };
		if (localSymbols.length > 1 || workspaceSymbols.length > 1) return { confidence: "partial" };
		return { confidence: "unknown" };
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
		return { value: members, confidence: "exact" };
	}
}
