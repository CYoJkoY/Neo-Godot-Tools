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

/** Lifecycle states of the real client, whose values are strings. */
const ClientState = {
	Initial: "initial",
	Starting: "starting",
	StartFailed: "startFailed",
	Running: "running",
	Stopping: "stopping",
	Stopped: "stopped",
} as const;

/**
 * Startup behaviour armed for the next `start` call.
 *
 * The real client performs the `initialize` handshake inside `start`, so a test
 * needs to hold it pending (to observe the startup window) or make it fail.
 */
const armed_start: { pending?: () => Promise<void> } = {};

/**
 * Makes the next `start` stay pending until the returned function is called.
 *
 * Lets a test act while the handshake is in flight, which is when the
 * connection teardown used to reject the pending `initialize` request.
 */
export function __defer_client_start(): () => void {
	const gate: { release: () => void } = { release: () => {} };
	armed_start.pending = () => {
		return new Promise<void>((resolve) => {
			gate.release = resolve;
		});
	};
	return () => gate.release();
}

/** Makes the next `start` reject, as a failed handshake does. */
export function __fail_client_start(message: string): void {
	armed_start.pending = () => Promise.reject(new Error(message));
}

class LanguageClient {
	public id: string;
	public name: string;
	public clientOptions: unknown;
	public state: string = ClientState.Initial;

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

	async start(): Promise<void> {
		const pending = armed_start.pending;
		armed_start.pending = undefined;
		this.state = ClientState.Starting;
		try {
			await pending?.();
		} catch (error) {
			this.state = ClientState.StartFailed;
			return Promise.reject(error);
		}
		this.state = ClientState.Running;
	}
	async stop(): Promise<void> {
		this.state = ClientState.Stopped;
	}
	async dispose(): Promise<void> {}
	needsStart(): boolean {
		return (
			this.state === ClientState.Initial ||
			this.state === ClientState.Stopping ||
			this.state === ClientState.Stopped
		);
	}
	needsStop(): boolean {
		return this.state === ClientState.Starting || this.state === ClientState.Running;
	}
	isRunning(): boolean {
		return this.state === ClientState.Running;
	}
	error(_message: string, _data?: unknown, _showNotification?: boolean | "force"): void {}
	warn(_message: string, _data?: unknown, _showNotification?: boolean): void {}
	info(_message: string, _data?: unknown, _showNotification?: boolean): void {}
	debug(_message: string, _data?: unknown, _showNotification?: boolean): void {}
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
