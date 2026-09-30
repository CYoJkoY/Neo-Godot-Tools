/**
 * Minimal stand-in for `vscode-languageclient`, used by the headless unit tests.
 *
 * The real package builds protocol classes on top of the VS Code API at import
 * time, which requires a full extension host. Unit tests only need the request
 * descriptors that the local fallbacks pass to `sendRequest`, plus enough of
 * `LanguageClient` for modules that subclass it to load.
 */

const vscode = require("./vscode_stub.cjs");

/** Mirrors the parts of `MessageSignature` used by the custom LSP client. */
class MessageSignature {
	constructor(method, message) {
		this.method = method;
		this.message = message;
		this.number = 0;
	}

	toString() {
		return this.method;
	}
}

class LanguageClient {
	constructor(id, nameOrOptions, clientOptions) {
		this.id = id;
		if (typeof nameOrOptions === "string") {
			this.name = nameOrOptions;
			this.clientOptions = clientOptions;
		} else {
			this.name = id;
			this.clientOptions = nameOrOptions;
		}
		this.state = 1;
	}

	async start() {}
	async stop() {}
	async dispose() {}
	sendRequest() {
		return Promise.reject(new Error("No language server is available in headless unit tests."));
	}
	sendNotification() {
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

const request = (method) => ({ type: { method } });

module.exports = {
	LanguageClient,
	MessageSignature,
	State: { Stopped: 1, Starting: 2, Running: 3 },
	CompletionRequest: request("textDocument/completion"),
	DefinitionRequest: request("textDocument/definition"),
	DocumentSymbolRequest: request("textDocument/documentSymbol"),
	HoverRequest: request("textDocument/hover"),
	ReferencesRequest: request("textDocument/references"),
	RenameRequest: request("textDocument/rename"),
	SignatureHelpRequest: request("textDocument/signatureHelp"),
	// Re-exported VS Code enums/types that extension modules use directly.
	SymbolKind: vscode.SymbolKind,
	Range: vscode.Range,
	Location: vscode.Location,
	__stub: true,
};
