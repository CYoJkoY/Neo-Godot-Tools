/**
 * Minimal stand-in for `vscode-languageclient`, used by the headless unit tests.
 *
 * The real package builds protocol classes on top of the VS Code API at import
 * time, which requires a full extension host. Unit tests only need the request
 * descriptors that the local fallbacks pass to `sendRequest`, plus enough of
 * `LanguageClient` for modules that subclass it to load.
 */

import * as vscode from "./vscode_stub.js";

/** Mirrors the parts of `MessageSignature` used by the custom LSP client. */
class MessageSignature {
	public number = 0;

	constructor(
		public method: string,
		public message = "",
	) {}

	toString(): string {
		return this.method;
	}
}

class LanguageClient {
	public id: string;
	public name: string;
	public clientOptions: unknown;
	public state = 1;

	constructor(id: string, nameOrOptions?: unknown, clientOptions?: unknown) {
		this.id = id;
		if (typeof nameOrOptions === "string") {
			this.name = nameOrOptions;
			this.clientOptions = clientOptions;
		} else {
			this.name = id;
			this.clientOptions = nameOrOptions;
		}
	}

	async start(): Promise<void> {}
	async stop(): Promise<void> {}
	async dispose(): Promise<void> {}
	sendRequest(): Promise<never> {
		return Promise.reject(new Error("No language server is available in headless unit tests."));
	}
	sendNotification(): Promise<void> {
		return Promise.resolve();
	}
	onNotification() {
		return { dispose: () => {} };
	}
	onRequest() {
		return { dispose: () => {} };
	}
	onDidChangeState() {
		return { dispose: () => {} };
	}
}

const request = (method: string) => ({ type: { method } });
const State = { Stopped: 1, Starting: 2, Running: 3 };
const CompletionRequest = request("textDocument/completion");
const DefinitionRequest = request("textDocument/definition");
const DocumentSymbolRequest = request("textDocument/documentSymbol");
const HoverRequest = request("textDocument/hover");
const ReferencesRequest = request("textDocument/references");
const RenameRequest = request("textDocument/rename");
const SignatureHelpRequest = request("textDocument/signatureHelp");
const __stub = true;
// Re-exported VS Code enums/types that extension modules use directly.
const SymbolKind = vscode.SymbolKind;
const Range = vscode.Range;
const Location = vscode.Location;

export {
	LanguageClient,
	MessageSignature,
	State,
	CompletionRequest,
	DefinitionRequest,
	DocumentSymbolRequest,
	HoverRequest,
	ReferencesRequest,
	RenameRequest,
	SignatureHelpRequest,
	SymbolKind,
	Range,
	Location,
	__stub,
};
