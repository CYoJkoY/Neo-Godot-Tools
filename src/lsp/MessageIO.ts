import { Socket } from "net";
import { EventEmitter } from "node:events";
import {
	AbstractMessageReader,
	AbstractMessageWriter,
	type DataCallback,
	type Disposable,
	type MessageReader,
	type MessageWriter,
	type NotificationMessage,
	type RequestMessage,
	type ResponseMessage,
} from "vscode-jsonrpc";
import { createLogger } from "../utils";
import MessageBuffer, { type MessageBufferListener } from "./MessageBuffer";

const log = createLogger("lsp.io", { output: "Godot LSP" });

export type Message = RequestMessage | ResponseMessage | NotificationMessage;

/**
 * Decodes one frame from the transport, or `undefined` when its body is not a
 * JSON object. Checking here keeps a malformed payload away from the message
 * filters, which read JSON-RPC fields without guarding the shape.
 */
function parse_message(message: string): Message | undefined {
	try {
		const parsed: unknown = JSON.parse(message);
		if (typeof parsed !== "object" || parsed === null) return undefined;
		// Assertion: a non-null object is the shape every JSON-RPC message has.
		return parsed as Message;
	} catch (error) {
		log.debug(`discarding an undecodable frame: ${error instanceof Error ? error.message : String(error)}`);
		return undefined;
	}
}

export class MessageIO extends EventEmitter {
	reader = new MessageIOReader(this);
	writer = new MessageIOWriter(this);

	requestFilter: (msg: RequestMessage) => RequestMessage | false = (msg) => msg;
	responseFilter: (msg: ResponseMessage) => ResponseMessage | false = (msg) => msg;
	notificationFilter: (msg: NotificationMessage) => NotificationMessage | false = (msg) => msg;

	socket?: Socket;
	messageCache: string[] = [];

	/**
	 * `connect` attempts, newest last.
	 *
	 * Every attempt owns one socket. A socket left over from an earlier attempt
	 * must not touch shared state: its late `error`/`close` would otherwise clear
	 * `socket` and report `disconnected`, tearing down the connection that is
	 * currently in use (observed as "Server initialization failed." while the
	 * JSON-RPC `initialize` request is still pending).
	 */
	private generation = 0;
	/** Settles the promise of the attempt that is still in flight, if any. */
	private settleConnect?: () => void;

	async connect(host: string, port: number): Promise<void> {
		log.debug(`connecting to ${host}:${port}`);
		this.settle_connect();
		const generation = ++this.generation;
		this.drop_socket();

		return new Promise((resolve) => {
			const isCurrent = () => generation === this.generation;

			this.settleConnect = resolve;

			const socket = new Socket();
			socket.connect(port, host);

			socket.once("connect", () => {
				if (!isCurrent()) {
					socket.destroy();
					return;
				}
				this.socket = socket;

				const cursor = { index: 0 };
				while (cursor.index < this.messageCache.length) socket.write(this.messageCache[cursor.index++]);
				this.messageCache.length = 0;

				this.emit("connected");
				this.settle_connect();
			});
			socket.on("data", (chunk: Buffer) => {
				if (isCurrent()) this.emit("data", chunk);
			});
			socket.on("error", (error: Error) => {
				// A refused or reset connection is reported through `close`, which
				// drives the reconnect. Logging the cause keeps it diagnosable.
				log.debug(`connection to ${host}:${port} failed: ${error.message}`);
				if (!isCurrent()) return;
				this.socket = undefined;
				this.settle_connect();
			});
			socket.on("close", () => {
				if (!isCurrent()) return;
				this.socket = undefined;
				this.emit("disconnected");
				this.emit("close");
				this.settle_connect();
			});
		});
	}

	write(message: string) {
		if (this.socket) {
			this.socket.write(message);
		} else {
			this.messageCache.push(message);
		}
	}

	/** Resolves the connect promise that is still in flight, if there is one. */
	private settle_connect(): void {
		const settle = this.settleConnect;
		this.settleConnect = undefined;
		settle?.();
	}

	/**
	 * Forgets the active socket without reporting a disconnection: whatever the
	 * socket reports afterwards belongs to a connection that is no longer used.
	 */
	private drop_socket(): void {
		const socket = this.socket;
		this.socket = undefined;
		if (socket === undefined) return;
		socket.removeAllListeners();
		// Writes still in flight may fail once the socket is destroyed.
		socket.on("error", () => {});
		socket.destroy();
	}
}

export class MessageIOReader extends AbstractMessageReader implements MessageReader, MessageBufferListener {
	/** Set by `listen`; the reader delivers every complete message through it. */
	private callback: DataCallback = () => {};
	private buffer = new MessageBuffer(this);
	/** Listeners of the active `listen` call, released by its disposable. */
	private listeners?: {
		data: (chunk: Buffer) => void;
		error: (error: Error) => void;
		close: () => void;
	};

	constructor(public io: MessageIO) {
		super();
	}

	/** Forwards a stalled message to the jsonrpc listener (see `MessageBufferListener`). */
	notifyPartialMessage(message: { messageToken: number; waitingTime: number }): void {
		this.firePartialMessage(message);
	}

	/**
	 * Registers `callback` for complete messages, replacing any earlier
	 * registration. Registering again without releasing the previous listeners
	 * would deliver every message once per registration, so a client that is
	 * stopped and started again would receive stale duplicates.
	 */
	listen(callback: DataCallback): Disposable {
		this.stop_listening();
		this.buffer.reset();

		this.callback = callback;

		const listeners = {
			data: (chunk: Buffer) => this.on_data(chunk),
			error: (error: Error) => this.fireError(error),
			close: () => this.fireClose(),
		};
		this.listeners = listeners;
		this.io.on("data", listeners.data);
		this.io.on("error", listeners.error);
		this.io.on("close", listeners.close);

		return { dispose: () => this.stop_listening() };
	}

	override dispose(): void {
		this.stop_listening();
		super.dispose();
	}

	/** Detaches from the io so a stopped client receives no further messages. */
	private stop_listening(): void {
		const listeners = this.listeners;
		this.listeners = undefined;
		if (listeners === undefined) return;
		this.io.removeListener("data", listeners.data);
		this.io.removeListener("error", listeners.error);
		this.io.removeListener("close", listeners.close);
	}

	private on_data(data: Buffer | string): void {
		this.buffer.append(data);
		for (let message = this.buffer.ready(); message !== undefined; message = this.buffer.ready()) {
			const json = parse_message(message);
			if (json === undefined) {
				// A frame that cannot be decoded means the stream is out of sync.
				// Report it through the reader instead of letting the exception
				// escape a socket event, which would crash the extension host.
				this.fireError(new Error("the language server sent a frame that is not a JSON object"));
				return;
			}
			// Both filters may rewrite a message before it reaches the client.
			const modified = "id" in json ? this.io.responseFilter(json) : this.io.notificationFilter(json);
			if (modified === false) continue;
			log.debug("rx:", modified);
			this.callback(modified);
		}
	}
}

export class MessageIOWriter extends AbstractMessageWriter implements MessageWriter {
	private errorCount = 0;

	constructor(public io: MessageIO) {
		super();
	}

	async write(msg: RequestMessage) {
		const modified = this.io.requestFilter(msg);
		if (modified === false) {
			log.debug("tx [discarded]:", msg);
			return;
		}
		log.debug("tx:", modified);
		const json = JSON.stringify(modified);

		const contentLength = Buffer.byteLength(json, "utf-8").toString();
		const message = `Content-Length: ${contentLength}\r\n\r\n${json}`;
		try {
			this.io.write(message);
			this.errorCount = 0;
		} catch (error) {
			this.errorCount++;
			this.fireError(error, modified, this.errorCount);
		}
	}

	end(): void {}
}
