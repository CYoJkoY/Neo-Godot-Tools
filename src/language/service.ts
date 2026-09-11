import * as vscode from "vscode";
import { FileIndex, IndexedSymbol, ReferenceIndex, SymbolIndex } from "../index";
import { DefinitionFallback } from "../fallback/definition";
import { ReferencesFallback } from "../fallback/references";

export class LanguageService implements vscode.Disposable {
	readonly files = new FileIndex();
	readonly symbols = new SymbolIndex(this.files);
	readonly references = new ReferenceIndex(this.files);
	private readonly disposables: vscode.Disposable[] = [];
	private scanGeneration = 0;

	constructor(
		private readonly definitionFallback: DefinitionFallback,
		private readonly referencesFallback: ReferencesFallback,
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

		const name = document.getText(range);
		const symbols = this.symbols.find(name);
		if (symbols.length !== 1) return this.referencesFallback.provide(document, position, { includeDeclaration }, token);

		return this.references.findForSymbol(symbols[0], includeDeclaration).map((reference) => new vscode.Location(
			vscode.Uri.parse(reference.uri),
			new vscode.Range(
				reference.range.start.line,
				reference.range.start.character,
				reference.range.end.line,
				reference.range.end.character,
			),
		));
	}

	private toLocation(symbol: IndexedSymbol): vscode.Location {
		return new vscode.Location(vscode.Uri.parse(symbol.uri), new vscode.Range(
			symbol.range.start.line,
			symbol.range.start.character,
			symbol.range.end.line,
			symbol.range.end.character,
		));
	}

	private updateDocument(document: vscode.TextDocument): void {
		if (document.languageId !== "gdscript" || document.uri.scheme !== "file") return;
		const uri = document.uri.toString();
		this.files.update(uri, document.getText(), document.version);
		this.symbols.update(uri);
		this.references.update(uri);
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
		} catch {
			this.remove(uri);
		}
	}

	private remove(uri: string | vscode.Uri): void {
		const key = typeof uri === "string" ? uri : uri.toString();
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
