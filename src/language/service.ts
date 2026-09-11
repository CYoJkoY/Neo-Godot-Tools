import * as vscode from "vscode";
import { FileIndex, IndexedParameter, IndexedSymbol, Binding, BindingIndex, ReferenceIndex, SymbolIndex, TypeResolutionIndex, DependencyGraph } from "../index";
import { DefinitionFallback } from "../fallback/definition";
import { ReferencesFallback } from "../fallback/references";
import { RenameFallback } from "../fallback/rename";
import { ScheduledUpdate, UpdateScheduler } from "./update_scheduler";

function wordRange(document: vscode.TextDocument, position: vscode.Position): vscode.Range | undefined {
	return document.getWordRangeAtPosition(position, /[A-Za-z_][A-Za-z0-9_]*/);
}

function symbolKind(kind: string): vscode.CompletionItemKind {
	switch (kind) {
		case "class":
		case "class_name": return vscode.CompletionItemKind.Class;
		case "function": return vscode.CompletionItemKind.Function;
		case "constant": return vscode.CompletionItemKind.Constant;
		case "variable": return vscode.CompletionItemKind.Field;
		case "signal": return vscode.CompletionItemKind.Event;
		case "enum": return vscode.CompletionItemKind.Enum;
		default: return vscode.CompletionItemKind.Value;
	}
}

function bindingKind(kind: Binding["kind"]): vscode.CompletionItemKind {
	switch (kind) {
		case "parameter":
		case "local": return vscode.CompletionItemKind.Variable;
		case "member": return vscode.CompletionItemKind.Field;
		case "function": return vscode.CompletionItemKind.Function;
		case "class":
		case "class_name": return vscode.CompletionItemKind.Class;
		case "constant": return vscode.CompletionItemKind.Constant;
		case "signal": return vscode.CompletionItemKind.Event;
		case "enum": return vscode.CompletionItemKind.Enum;
	}
}

export class LanguageService implements vscode.Disposable {
	readonly files = new FileIndex();
	readonly symbols = new SymbolIndex(this.files);
	readonly references = new ReferenceIndex(this.files);
	readonly bindings = new BindingIndex(this.files);
	readonly types = new TypeResolutionIndex(this.files, this.symbols, this.bindings);
	readonly dependencies = new DependencyGraph(this.files);
	private readonly disposables: vscode.Disposable[] = [];
	private readonly updateScheduler: UpdateScheduler;
	private scanGeneration = 0;

	constructor(
		private readonly definitionFallback: DefinitionFallback,
		private readonly referencesFallback: ReferencesFallback,
		private readonly renameFallback: RenameFallback,
	) {
		this.updateScheduler = new UpdateScheduler(30, (update) => this.applyScheduledUpdate(update));
		this.disposables.push(
			vscode.workspace.onDidOpenTextDocument((document) => this.scheduleDocument(document)),
			vscode.workspace.onDidChangeTextDocument((event) => this.scheduleDocument(event.document)),
			vscode.workspace.onDidSaveTextDocument((document) => this.scheduleDocument(document)),
		);
		const watcher = vscode.workspace.createFileSystemWatcher("**/*.gd");
		watcher.onDidCreate((uri) => this.scheduleUri(uri));
		watcher.onDidChange((uri) => this.scheduleUri(uri));
		watcher.onDidDelete((uri) => this.remove(uri));
		this.disposables.push(watcher);
		void this.rebuildWorkspaceIndex();
	}

	dispose(): void {
		this.scanGeneration++;
		this.updateScheduler.dispose();
		for (const disposable of this.disposables) disposable.dispose();
		this.files.clear();
		this.symbols.clear();
		this.references.clear();
		this.bindings.clear();
		this.dependencies.clear();
		this.types.clear();
	}

	getDocumentSymbols(uri: string): readonly IndexedSymbol[] { return this.files.get(uri)?.symbols ?? []; }
	getWorkspaceSymbols(query: string): IndexedSymbol[] { return this.symbols.workspaceSymbols(query); }

	async getDefinition(document: vscode.TextDocument, position: vscode.Position, token: vscode.CancellationToken): Promise<vscode.Definition | undefined> {
		const member = this.memberExpression(document, position);
		if (member) {
			const receiver = this.types.resolveReceiver(document.uri.toString(), document.offsetAt(position), member.receiver);
			const symbol = receiver ? this.types.getMember(receiver, member.member) : undefined;
			if (symbol) return this.toLocation(symbol);
		}
		const range = wordRange(document, position);
		if (range) {
			const name = document.getText(range);
			const binding = this.bindings.getBinding(document.uri.toString(), document.offsetAt(range.start), name);
			if (binding) return this.toLocation({ name: binding.name, kind: "variable", uri: binding.uri, range: binding.declarationRange });
			const fileSymbols = this.files.get(document.uri.toString())?.symbols.filter((symbol) => symbol.name === name) ?? [];
			if (fileSymbols.length === 1) return this.toLocation(fileSymbols[0]);
			const matches = this.symbols.find(name);
			if (matches.length === 1) return this.toLocation(matches[0]);
		}
		return this.definitionFallback.provide(document, position, token);
	}

	async getReferences(document: vscode.TextDocument, position: vscode.Position, includeDeclaration: boolean, token: vscode.CancellationToken): Promise<vscode.Location[] | undefined> {
		const range = wordRange(document, position);
		if (!range) return this.referencesFallback.provide(document, position, { includeDeclaration }, token);
		const binding = this.bindings.getBinding(document.uri.toString(), document.offsetAt(range.start), document.getText(range));
		if (!binding) return this.referencesFallback.provide(document, position, { includeDeclaration }, token);
		const references = this.bindings.findReferences(binding.id);
		if (!references.length) return this.referencesFallback.provide(document, position, { includeDeclaration }, token);
		return references.filter((reference) => includeDeclaration || reference.range.start.offset !== binding.declarationRange.start.offset || reference.uri !== binding.uri).map((reference) => this.toReferenceLocation(reference));
	}

	async getRenameEdits(document: vscode.TextDocument, position: vscode.Position, newName: string, token: vscode.CancellationToken): Promise<vscode.WorkspaceEdit | undefined> {
		if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(newName)) return undefined;
		const range = wordRange(document, position);
		if (!range) return this.renameFallback.provide(document, position, newName, token);
		const binding = this.bindings.getBinding(document.uri.toString(), document.offsetAt(range.start), document.getText(range));
		if (!binding) return this.renameFallback.provide(document, position, newName, token);
		const references = this.bindings.findReferences(binding.id);
		if (!references.length) return this.renameFallback.provide(document, position, newName, token);
		const edit = new vscode.WorkspaceEdit();
		for (const reference of references) edit.replace(vscode.Uri.parse(reference.uri), this.range(reference.range), newName);
		return edit;
	}

	getHover(document: vscode.TextDocument, position: vscode.Position): vscode.Hover | undefined {
		const member = this.memberExpression(document, position);
		if (member) {
			const receiver = this.types.resolveReceiver(document.uri.toString(), document.offsetAt(position), member.receiver);
			const symbol = receiver ? this.types.getMember(receiver, member.member) : undefined;
			if (symbol) return this.hoverForSymbol(symbol);
		}
		const range = wordRange(document, position);
		if (!range) return undefined;
		const name = document.getText(range);
		const binding = this.bindings.getBinding(document.uri.toString(), document.offsetAt(range.start), name);
		if (binding) return this.hoverForBinding(binding);
		const symbols = this.symbols.find(name);
		return symbols.length === 1 ? this.hoverForSymbol(symbols[0]) : undefined;
	}

	getCompletions(document: vscode.TextDocument, position: vscode.Position): vscode.CompletionList | undefined {
		const line = document.lineAt(position.line).text.slice(0, position.character);
		const memberMatch = line.match(/(?:^|\s)(self|[A-Za-z_]\w*)\.([A-Za-z_]\w*)?$/);
		if (memberMatch) {
			const receiverName = memberMatch[1];
			const prefix = memberMatch[2] ?? "";
			const receiver = this.types.resolveReceiver(document.uri.toString(), document.offsetAt(position), receiverName);
			if (receiver) {
				const items = this.types.getMembers(receiver).filter((symbol) => symbol.name.startsWith(prefix)).map((symbol) => this.toSymbolCompletion(symbol));
				if (items.length) return new vscode.CompletionList(items, false);
				return undefined;
			}
		}
		const range = wordRange(document, position);
		const prefix = range ? document.getText(range) : "";
		const bindings = this.bindings.getVisibleBindings(document.uri.toString(), document.offsetAt(position));
		const localItems = bindings.filter((binding) => binding.name.startsWith(prefix)).map((binding) => this.toBindingCompletion(binding));
		const localNames = new Set(localItems.map((item) => String(item.label)));
		const workspaceItems = this.symbols.workspaceSymbols(prefix).filter((symbol) => !localNames.has(symbol.name)).map((symbol) => this.toSymbolCompletion(symbol));
		if (!localItems.length && !workspaceItems.length) return undefined;
		return new vscode.CompletionList([...localItems, ...workspaceItems], false);
	}

	getSignatureHelp(document: vscode.TextDocument, position: vscode.Position): vscode.SignatureHelp | undefined {
		const before = document.getText(new vscode.Range(new vscode.Position(0, 0), position));
		const match = before.match(/(?:^|[^A-Za-z0-9_])([A-Za-z_]\w*)\s*\(([^()]*)$/);
		if (!match) return undefined;
		const name = match[1];
		const argumentText = match[2];
		const activeParameter = argumentText.trim() ? argumentText.split(",").length - 1 : 0;
		const callOffset = Math.max(0, document.offsetAt(position) - match[1].length - 1);
		const binding = this.bindings.getBinding(document.uri.toString(), callOffset, name);
		const symbols = binding?.kind === "function" ? [this.symbolForBinding(binding)].filter((symbol): symbol is IndexedSymbol => symbol !== undefined) : this.symbols.find(name);
		const functions = symbols.filter((symbol) => symbol.kind === "function");
		if (functions.length !== 1) return undefined;
		const symbol = functions[0];
		const signature = new vscode.SignatureInformation(this.signatureLabel(symbol));
		signature.parameters = (symbol.parameters ?? []).map((parameter) => new vscode.ParameterInformation(this.parameterLabel(parameter)));
		const help = new vscode.SignatureHelp();
		help.signatures = [signature];
		help.activeSignature = 0;
		help.activeParameter = Math.min(activeParameter, Math.max(0, signature.parameters.length - 1));
		return help;
	}

	private memberExpression(document: vscode.TextDocument, position: vscode.Position): { receiver: string; member: string } | undefined {
		const line = document.lineAt(position.line).text;
		const before = line.slice(0, position.character);
		const match = before.match(/([A-Za-z_]\w*)\.([A-Za-z_]\w*)$/);
		if (!match) return undefined;
		return { receiver: match[1], member: match[2] };
	}

	private hoverForBinding(binding: Binding): vscode.Hover {
		const symbol = this.symbolForBinding(binding);
		if (symbol) return this.hoverForSymbol(symbol);
		const markdown = new vscode.MarkdownString();
		markdown.appendCodeblock(this.bindingLabel(binding), "gdscript");
		return new vscode.Hover(markdown, this.range(binding.declarationRange));
	}

	private hoverForSymbol(symbol: IndexedSymbol): vscode.Hover {
		const markdown = new vscode.MarkdownString();
		markdown.appendCodeblock(this.symbolLabel(symbol), "gdscript");
		return new vscode.Hover(markdown, this.range(symbol.range));
	}

	private symbolForBinding(binding: Binding): IndexedSymbol | undefined {
		return this.files.get(binding.uri)?.symbols.find((symbol) => symbol.range.start.offset === binding.declarationRange.start.offset);
	}

	private symbolLabel(symbol: IndexedSymbol): string {
		if (symbol.kind === "function") return this.signatureLabel(symbol);
		if (symbol.kind === "variable" || symbol.kind === "constant") return `${symbol.kind} ${symbol.name}${symbol.type ? `: ${symbol.type}` : ""}`;
		if (symbol.containerName) return `${symbol.containerName}.${symbol.name}`;
		return `${symbol.kind} ${symbol.name}`;
	}

	private bindingLabel(binding: Binding): string {
		if (binding.kind === "function") return `${binding.name}()${binding.returnType ? ` -> ${binding.returnType}` : ""}`;
		return `${binding.kind} ${binding.name}${binding.type ? `: ${binding.type}` : ""}`;
	}

	private signatureLabel(symbol: IndexedSymbol): string {
		const parameters = (symbol.parameters ?? []).map((parameter) => this.parameterLabel(parameter)).join(", ");
		return `${symbol.name}(${parameters})${symbol.returnType ? ` -> ${symbol.returnType}` : ""}`;
	}

	private parameterLabel(parameter: IndexedParameter): string {
		return `${parameter.name}${parameter.type ? `: ${parameter.type}` : ""}${parameter.defaultValue !== undefined ? ` = ${parameter.defaultValue}` : ""}`;
	}

	private toBindingCompletion(binding: Binding): vscode.CompletionItem {
		const item = new vscode.CompletionItem(binding.name, bindingKind(binding.kind));
		item.detail = this.bindingLabel(binding);
		return item;
	}

	private toSymbolCompletion(symbol: IndexedSymbol): vscode.CompletionItem {
		const item = new vscode.CompletionItem(symbol.name, symbolKind(symbol.kind));
		item.detail = this.symbolLabel(symbol);
		return item;
	}

	private toLocation(symbol: IndexedSymbol): vscode.Location {
		return new vscode.Location(vscode.Uri.parse(symbol.uri), this.range(symbol.range));
	}

	private toReferenceLocation(reference: { uri: string; range: { start: { line: number; character: number }; end: { line: number; character: number } } }): vscode.Location {
		return new vscode.Location(vscode.Uri.parse(reference.uri), this.range(reference.range));
	}

	private range(sourceRange: { start: { line: number; character: number }; end: { line: number; character: number } }): vscode.Range {
		return new vscode.Range(sourceRange.start.line, sourceRange.start.character, sourceRange.end.line, sourceRange.end.character);
	}

	private scheduleDocument(document: vscode.TextDocument): void {
		if (document.languageId !== "gdscript" || document.uri.scheme !== "file") return;
		this.updateScheduler.enqueue({ uri: document.uri.toString(), source: document.getText(), version: document.version });
	}

	private scheduleUri(uri: vscode.Uri): void {
		const key = uri.toString();
		const openDocument = vscode.workspace.textDocuments.find((document) => document.uri.toString() === key);
		if (openDocument) {
			this.scheduleDocument(openDocument);
			return;
		}
		this.updateScheduler.enqueue({ uri: key, version: 0 });
	}

	private async applyScheduledUpdate(update: ScheduledUpdate): Promise<void> {
		if (update.source !== undefined) {
			this.updateText(update.uri, update.source, update.version);
			return;
		}
		const uri = vscode.Uri.parse(update.uri);
		const openDocument = vscode.workspace.textDocuments.find((document) => document.uri.toString() === update.uri);
		if (openDocument) {
			if (openDocument.version >= update.version) this.updateText(update.uri, openDocument.getText(), openDocument.version);
			return;
		}
		try {
			const bytes = await vscode.workspace.fs.readFile(uri);
			if (!this.updateScheduler.isCurrent(update)) return;
			this.updateText(update.uri, Buffer.from(bytes).toString("utf8"), update.version);
		} catch {
			if (this.updateScheduler.isCurrent(update)) this.remove(uri);
		}
	}

	private updateText(uri: string, source: string, version = 0): void {
		const affected = this.dependencies.getTransitiveDependents(uri);
		this.files.update(uri, source, version);
		this.symbols.update(uri);
		this.references.update(uri);
		this.bindings.update(uri);
		this.dependencies.update(uri);
		this.types.invalidate([uri, ...affected]);
	}

	private remove(uri: string | vscode.Uri): void {
		const key = typeof uri === "string" ? uri : uri.toString();
		this.updateScheduler.cancel(key);
		const affected = this.dependencies.getTransitiveDependents(key);
		this.dependencies.remove(key);
		this.types.invalidate([key, ...affected]);
		this.bindings.remove(key);
		this.references.remove(key);
		this.symbols.remove(key);
		this.files.remove(key);
	}

	private async rebuildWorkspaceIndex(): Promise<void> {
		const generation = ++this.scanGeneration;
		const files = await vscode.workspace.findFiles("**/*.gd", "**/{.git,node_modules}/**");
		for (const uri of files) {
			if (generation !== this.scanGeneration) return;
			await this.updateUri(uri);
			await new Promise<void>((resolve) => setImmediate(resolve));
		}
	}

	private async updateUri(uri: vscode.Uri): Promise<void> {
		const openDocument = vscode.workspace.textDocuments.find((document) => document.uri.toString() === uri.toString());
		if (openDocument) {
			this.scheduleDocument(openDocument);
			return;
		}
		try {
			const bytes = await vscode.workspace.fs.readFile(uri);
			this.updateText(uri.toString(), Buffer.from(bytes).toString("utf8"));
		} catch {
			this.remove(uri);
		}
	}
}
