import * as vscode from "vscode";
import { FileIndex, IndexedSymbol, BindingIndex, ReferenceIndex, SymbolIndex } from "../index";
import { DefinitionFallback } from "../fallback/definition";
import { ReferencesFallback } from "../fallback/references";
import { RenameFallback } from "../fallback/rename";

export class LanguageService implements vscode.Disposable {
	readonly files = new FileIndex();
	readonly symbols = new SymbolIndex(this.files);
	readonly references = new ReferenceIndex(this.files);
	readonly bindings = new BindingIndex(this.files);
	private readonly disposables: vscode.Disposable[] = [];
	private scanGeneration = 0;

	constructor(
		private readonly definitionFallback: DefinitionFallback,
		private readonly referencesFallback: ReferencesFallback,
		private readonly renameFallback: RenameFallback,
	) {
		this.disposables.push(
			vscode.workspace.onDidOpenTextDocument((document) => this.updateDocument(document)),
			vscode.workspace.onDidChangeTextDocument((event) => this.updateDocument(event.document)),
			vscode.workspace.onDidSaveTextDocument((document) => this.updateDocument(document)),
		);

		const watcher = vscode.workspace.createFileSystemWatcher("**/*.gd");
		watcher.onDidCreate((uri) => void this.updateUri(uri));
		watcher.onDidChange((uri) => void this.updateUri(uri));
		watcher.onDidDelete((uri) => this.remove(uri));
		this.disposables.push(watcher);
		void this.rebuildWorkspaceIndex();
	}

	dispose(): void {
		this.scanGeneration++;
		for (const disposable of this.disposables) disposable.dispose();
		this.files.clear();
		this.symbols.clear();
		this.references.clear();
		this.bindings.clear();
	}

	getDocumentSymbols(uri: string): readonly IndexedSymbol[] {
		return this.files.get(uri)?.symbols ?? [];
	}

	getWorkspaceSymbols(query: string): IndexedSymbol[] {
		return this.symbols.workspaceSymbols(query);
	}

	async getDefinition(document: vscode.TextDocument, position: vscode.Position, token: vscode.CancellationToken): Promise<vscode.Definition | undefined> {
		const range = document.getWordRangeAtPosition(position, /[A-Za-z_][A-Za-z0-9_]*/);
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

	async getReferences(
		document: vscode.TextDocument,
		position: vscode.Position,
		includeDeclaration: boolean,
		token: vscode.CancellationToken,
	): Promise<vscode.Location[] | undefined> {
		const range = document.getWordRangeAtPosition(position, /[A-Za-z_][A-Za-z0-9_]*/);
		if (!range) return this.referencesFallback.provide(document, position, { includeDeclaration }, token);
		const binding = this.bindings.getBinding(document.uri.toString(), document.offsetAt(range.start), document.getText(range));
		if (!binding) return this.referencesFallback.provide(document, position, { includeDeclaration }, token);
		const references = this.bindings.findReferences(binding.id);
		if (!references.length) return this.referencesFallback.provide(document, position, { includeDeclaration }, token);
		return references
			.filter((reference) => includeDeclaration || reference.range.start.offset !== binding.declarationRange.start.offset || reference.uri !== binding.uri)
			.map((reference) => this.toReferenceLocation(reference));
	}

	async getRenameEdits(
		document: vscode.TextDocument,
		position: vscode.Position,
		newName: string,
		token: vscode.CancellationToken,
	): Promise<vscode.WorkspaceEdit | undefined> {
		if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(newName)) return undefined;
		const range = document.getWordRangeAtPosition(position, /[A-Za-z_][A-Za-z0-9_]*/);
		if (!range) return this.renameFallback.provide(document, position, newName, token);
		const binding = this.bindings.getBinding(document.uri.toString(), document.offsetAt(range.start), document.getText(range));
		if (!binding) return this.renameFallback.provide(document, position, newName, token);
		const references = this.bindings.findReferences(binding.id);
		if (!references.length) return this.renameFallback.provide(document, position, newName, token);
		const edit = new vscode.WorkspaceEdit();
		for (const reference of references) edit.replace(
			vscode.Uri.parse(reference.uri),
			new vscode.Range(
				reference.range.start.line,
				reference.range.start.character,
				reference.range.end.line,
				reference.range.end.character,
			),
			newName,
		);
		return edit;
	}

	private toLocation(symbol: IndexedSymbol): vscode.Location {
		return new vscode.Location(vscode.Uri.parse(symbol.uri), new vscode.Range(
			symbol.range.start.line,
			symbol.range.start.character,
			symbol.range.end.line,
			symbol.range.end.character,
		));
	}

	private toReferenceLocation(reference: { uri: string; range: { start: { line: number; character: number }; end: { line: number; character: number } } }): vscode.Location {
		return new vscode.Location(vscode.Uri.parse(reference.uri), new vscode.Range(
			reference.range.start.line,
			reference.range.start.character,
			reference.range.end.line,
			reference.range.end.character,
		));
	}

	private updateDocument(document: vscode.TextDocument): void {
		if (document.languageId !== "gdscript" || document.uri.scheme !== "file") return;
		const uri = document.uri.toString();
		this.files.update(uri, document.getText(), document.version);
		this.symbols.update(uri);
		this.references.update(uri);
		this.bindings.update(uri);
	}

	private async updateUri(uri: vscode.Uri): Promise<void> {
		const openDocument = vscode.workspace.textDocuments.find((document) => document.uri.toString() === uri.toString());
		if (openDocument) {
			this.updateDocument(openDocument);
			return;
		}
		try {
			const bytes = await vscode.workspace.fs.readFile(uri);
			const source = Buffer.from(bytes).toString("utf8");
			this.files.update(uri.toString(), source);
			this.symbols.update(uri.toString());
			this.references.update(uri.toString());
			this.bindings.update(uri.toString());
		} catch {
			this.remove(uri);
		}
	}

	private remove(uri: string | vscode.Uri): void {
		const key = typeof uri === "string" ? uri : uri.toString();
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
}
