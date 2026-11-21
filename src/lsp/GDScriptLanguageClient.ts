import EventEmitter from "node:events";
import { performance } from "node:perf_hooks";
import * as vscode from "vscode";
import {
	LanguageClient,
	type LanguageClientOptions,
	MessageSignature,
	type NotificationMessage,
	type RequestMessage,
	type ResponseMessage,
	type ServerOptions,
} from "vscode-languageclient/node";

import { globals } from "../extension";
import { languageProfiler } from "../performance/profiler";
import { createLogger, get_configuration, get_project_dir } from "../utils";
import { createLruCache } from "../utils/lru_cache";
import { MessageIO } from "./MessageIO";
import { stopAfterStart } from "./client_lifecycle";
import { is_same_workspace } from "./workspace_path";

const log = createLogger("lsp.client", { output: "Godot LSP" });

const BUILTIN_SYMBOL_TIMEOUT_MS = 300;

/** Message the language client logs when the handshake with the server fails. */
const CONNECT_FAILED_MESSAGE = "couldn't create connection to server";

/** Text of an error, for logging an `unknown` rejection reason. */
const describe_error = (error: unknown): string => (error instanceof Error ? error.message : String(error));

enum ClientStatus {
	PENDING = 0,
	DISCONNECTED = 1,
	CONNECTED = 2,
	REJECTED = 3,
}

export { ClientStatus };

export enum TargetLSP {
	HEADLESS = 0,
	EDITOR = 1,
}

export type Target = {
	host: string;
	port: number;
	type: TargetLSP;
};

type HoverResult = {
	contents: {
		kind: string;
		value: string;
	};
	range: {
		end: {
			character: number;
			line: number;
		};
		start: {
			character: number;
			line: number;
		};
	};
};

type HoverResponseMesssage = {
	id: number;
	jsonrpc: string;
	result: HoverResult;
};

type ChangeWorkspaceNotification = {
	method: string;
	params: {
		path: string;
	};
};

type DocumentLinkResult = {
	range: {
		end: {
			character: number;
			line: number;
		};
		start: {
			character: number;
			line: number;
		};
	};
	target: string;
};

type DocumentLinkResponseMessage = {
	id: number;
	jsonrpc: string;
	result: DocumentLinkResult[];
};

export default class GDScriptLanguageClient extends LanguageClient {
	public io: MessageIO = new MessageIO();

	public target: TargetLSP = TargetLSP.EDITOR;

	public port = -1;
	public lastPortTried = -1;
	/**
	 * In-flight requests, keyed by request id.
	 *
	 * Bounded: a request that never receives a response (a disconnected or
	 * wedged server) would otherwise be retained for the whole session.
	 */
	public sentMessages = createLruCache<string | number, RequestMessage>({ capacity: 512 });
	private readonly requestStarts = createLruCache<string | number, number>({ capacity: 512 });
	private rejected = false;
	private startPromise?: Promise<void>;
	/** Whether `super.start` is still completing the `initialize` handshake. */
	private starting = false;
	/**
	 * Set when the connection must be dropped, but not while the JSON-RPC
	 * `initialize` request is in flight: disposing the transport at that point
	 * rejects that request ("Pending response rejected since connection got
	 * disposed") instead of reporting the intended outcome.
	 */
	private releaseWhenStarted = false;

	events = new EventEmitter();

	private _status: ClientStatus = ClientStatus.PENDING;

	get status(): ClientStatus {
		return this._status;
	}

	public set status(v: ClientStatus) {
		this._status = v;
		this.events.emit("status", this._status);
	}

	constructor() {
		const serverOptions: ServerOptions = () => {
			return new Promise((resolve) => {
				resolve({ reader: this.io.reader, writer: this.io.writer });
			});
		};

		const clientOptions: LanguageClientOptions = {
			// Transport failures are recovered by the connection manager, which
			// retries with a fresh client. Answering `false` stops this client
			// without the language client's own error dialog for the rejected
			// `initialize` request.
			initializationFailedHandler: (error: Error): boolean => {
				log.warn(`LSP initialization failed: ${error.message}`);
				return false;
			},
			documentSelector: [
				{ scheme: "file", language: "gdscript" },
				{ scheme: "untitled", language: "gdscript" },
				{ scheme: "file", language: "gdshader" },
				{ scheme: "untitled", language: "gdshader" },
			],
			middleware: {
				// The extension registers its own interactive providers so that local semantic
				// results are authoritative and the Godot LSP is used only as a fallback.
				// Keep the LanguageClient's corresponding providers inactive to avoid VS Code
				// merging two independent hover/definition/etc. results into the UI.
				provideHover: (document, position, token, next) =>
					document.languageId === "gdshader" ? next(document, position, token) : undefined,
				provideDefinition: (document, position, token, next) =>
					document.languageId === "gdshader" ? next(document, position, token) : undefined,
				provideReferences: (document, position, options, token, next) =>
					document.languageId === "gdshader" ? next(document, position, options, token) : undefined,
				provideRenameEdits: (document, position, newName, token, next) =>
					document.languageId === "gdshader" ? next(document, position, newName, token) : undefined,
				provideCompletionItem: (document, position, context, token, next) =>
					document.languageId === "gdshader" ? next(document, position, context, token) : undefined,
				provideSignatureHelp: (document, position, context, token, next) =>
					document.languageId === "gdshader" ? next(document, position, context, token) : undefined,
				provideDocumentSymbols: (document, token, next) =>
					document.languageId === "gdshader" ? next(document, token) : undefined,
				provideWorkspaceSymbols: async () => undefined,
			},
		};

		super("GDScriptLanguageClient", serverOptions, clientOptions);
		this.status = ClientStatus.PENDING;
		this.io.on("connected", this.on_connected.bind(this));
		this.io.on("disconnected", this.on_disconnected.bind(this));
		this.io.requestFilter = this.request_filter.bind(this);
		this.io.responseFilter = this.response_filter.bind(this);
		this.io.notificationFilter = this.notification_filter.bind(this);
	}

	override start(): Promise<void> {
		const starting = super.start();
		this.startPromise = starting;
		this.starting = true;
		const settle = (failed: boolean) => {
			if (this.startPromise !== starting) return;
			this.startPromise = undefined;
			this.starting = false;
			if (failed) {
				// A failed handshake leaves the transport unusable. Dropping the
				// socket reports `disconnected`, which makes the manager rebuild
				// the connection instead of keeping a client that cannot restart.
				this.releaseWhenStarted = false;
				this.release_socket();
				return;
			}
			if (this.releaseWhenStarted) {
				this.releaseWhenStarted = false;
				this.release_socket();
			}
		};
		void starting.then(
			() => settle(false),
			() => settle(true),
		);
		return starting;
	}

	override async stop(): Promise<void> {
		await stopAfterStart(this.startPromise, () => this.isRunning(), () => super.stop());
	}

	/**
	 * A failed handshake is reported through the connection manager's status
	 * widget and retried, so it is logged instead of interrupting the user with
	 * a dialog. The output channel keeps the full message either way.
	 */
	override error(message: string, data?: unknown, showNotification?: boolean | "force"): void {
		if (this.starting && message.includes(CONNECT_FAILED_MESSAGE)) {
			super.error(message, data, false);
			return;
		}
		super.error(message, data, showNotification);
	}

	connect(target: TargetLSP = TargetLSP.EDITOR) {
		this.rejected = false;
		this.releaseWhenStarted = false;
		this.target = target;
		this.status = ClientStatus.PENDING;

		let port = get_configuration("lsp.serverPort", 6008);
		if (this.port !== -1) port = this.port;
		if (this.target === TargetLSP.EDITOR && (port === 6005 || port === 6008)) port = 6005;

		const host = get_configuration("lsp.serverHost", "127.0.0.1");
		log.info(`attempting to connect to LSP at ${host}:${port}`);
		if (!this.needsStop()) {
			this.open_socket(host, port);
			return;
		}
		// A running client owns the transport: replacing it under a live
		// JSON-RPC connection would leave the old handshake pending.
		void this.stop().then(
			() => this.open_socket(host, port),
			(error: unknown) => {
				log.warn(`failed to stop the previous LSP connection: ${describe_error(error)}`);
				this.open_socket(host, port);
			},
		);
	}

	override handleFailedRequest<T>(
		type: MessageSignature,
		token: vscode.CancellationToken | undefined,
		error: Error,
		defaultValue: T,
		showNotification?: boolean,
	): T {
		if (
			type.method === "textDocument/documentSymbol" &&
			error.message.includes("selectionRange must be contained in fullRange")
		) {
			log.warn(`Request failed for method "${type.method}", suppressing notification - see issue #820`);
			return super.handleFailedRequest(type, token, error, defaultValue, false);
		}
		return super.handleFailedRequest(type, token, error, defaultValue, showNotification);
	}

	private request_filter(message: RequestMessage) {
		if (this.rejected) {
			if (message.method === "shutdown") return message;
			return false;
		}

		if (message.method === "workspace/didChangeWatchedFiles" || message.method === "workspace/symbol") return false;

		if (message.id === null) return message;
		this.sentMessages.set(message.id, message);
		this.requestStarts.set(message.id, performance.now());
		return message;
	}

	private response_filter(message: ResponseMessage) {
		const sentMessage = message.id === null ? undefined : this.sentMessages.get(message.id);
		if (message.id !== null) {
			const startedAt = this.requestStarts.get(message.id);
			if (sentMessage && startedAt !== undefined) {
				languageProfiler.record(`lsp.request.${sentMessage.method}`, performance.now() - startedAt);
				this.requestStarts.delete(message.id);
				this.sentMessages.delete(message.id);
			}
		}
		if (sentMessage?.method === "textDocument/hover") {
			let value: string = (message as HoverResponseMesssage).result.contents.value;
			if (value) {
				value = value.replace(/\n[#]+/g, "\n");
				value = value.replaceAll("`br`", "\n\n");
				value = value.replace("`codeblocks`", "");
				value = value.replace("`/codeblocks`", "");
				value = value.replace("`gdscript`", "\nGDScript:\n```gdscript");
				value = value.replace("`/gdscript`", "```");
				value = value.replace("`csharp`", "\nC#:\n```csharp");
				value = value.replace("`/csharp`", "```");
				(message as HoverResponseMesssage).result.contents.value = value;
			}
		} else if (sentMessage?.method === "textDocument/documentLink") {
			const results: DocumentLinkResult[] = (message as DocumentLinkResponseMessage).result;
			if (!results) return message;
			const final_result: DocumentLinkResult[] = [];
			for (const result of results) if (!result.target.startsWith("uid://")) final_result.push(result);
			(message as DocumentLinkResponseMessage).result = final_result;
		}
		return message;
	}

	private async check_workspace(message: ChangeWorkspaceNotification) {
		if (this.rejected) return;
		const client_path = (await get_project_dir()) ?? "";
		// The server reports the project root whenever its own comparison with the
		// client root fails, so this check must apply the same rules. A stricter
		// comparison rejects a healthy connection over case or separator
		// differences and drops it mid-handshake.
		if (is_same_workspace(message.params.path, client_path)) return;
		log.warn(`the connected LSP serves "${message.params.path}", not "${client_path}"`);
		this.reject_connection();
	}

	private reject_connection() {
		this.rejected = true;
		if (this.starting) this.releaseWhenStarted = true;
		else this.release_socket();
	}

	/** Drops the transport; the resulting `disconnected` event reports the status. */
	private release_socket() {
		this.io.socket?.resetAndDestroy();
	}

	private open_socket(host: string, port: number) {
		this.lastPortTried = port;
		void this.io.connect(host, port);
	}

	private notification_filter(message: NotificationMessage) {
		if (message.method === "gdscript_client/changeWorkspace") {
			void this.check_workspace(message as ChangeWorkspaceNotification).catch((error: unknown) => {
				log.warn(`workspace check failed: ${describe_error(error)}`);
			});
		}
		if (message.method === "gdscript/capabilities") globals.docsProvider?.register_capabilities(message);
		return message;
	}

	public async get_symbol_at_position(uri: vscode.Uri, position: vscode.Position, token?: vscode.CancellationToken) {
		if (token?.isCancellationRequested) return undefined;

		const requestToken = new vscode.CancellationTokenSource();
		const cancellation = token?.onCancellationRequested(() => requestToken.cancel());
		const timeout = setTimeout(() => requestToken.cancel(), BUILTIN_SYMBOL_TIMEOUT_MS);
		try {
			const params = {
				textDocument: { uri: uri.toString() },
				position: { line: position.line, character: position.character },
			};
			const response = await this.sendRequest("textDocument/hover", params, requestToken.token);
			if (token?.isCancellationRequested || !response) return undefined;
			return this.parse_hover_result(response as HoverResult);
		} catch {
			return undefined;
		} finally {
			clearTimeout(timeout);
			cancellation?.dispose();
			requestToken.dispose();
		}
	}

	private parse_hover_result(message: HoverResult) {
		const contents = message.contents;
		let decl: string;
		if (Array.isArray(contents)) decl = contents[0];
		else decl = contents.value;
		if (!decl) return "";
		decl = decl.split("\n")[0].trim();
		let match: RegExpMatchArray | null;
		let result: string | undefined = undefined;
		match = decl.match(/(?:func|const) (@?\w+)\.(\w+)/);
		if (match) result = `${match[1]}.${match[2]}`;
		match = decl.match(/<Native> class (\w+)/);
		if (match) result = `${match[1]}`;
		return result;
	}

	private on_connected() {
		this.status = ClientStatus.CONNECTED;
		const host = get_configuration("lsp.serverHost");
		log.info(`connected to LSP at ${host}:${this.lastPortTried}`);
	}

	private on_disconnected() {
		this.requestStarts.clear();
		this.sentMessages.clear();
		if (this.rejected) {
			this.status = ClientStatus.REJECTED;
			return;
		}
		if (this.target === TargetLSP.EDITOR) {
			const host = get_configuration("lsp.serverHost", "127.0.0.1");
			let port = get_configuration("lsp.serverPort", 6008);
			if (port === 6005 || port === 6008) {
				if (this.lastPortTried === 6005) {
					port = 6008;
					log.info(`attempting to connect to LSP at ${host}:${port}`);
					this.open_socket(host, port);
					return;
				}
			}
		}
		this.status = ClientStatus.DISCONNECTED;
	}
}
