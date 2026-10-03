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

export class MessageIO extends EventEmitter {
	reader = new MessageIOReader(this);
	writer = new MessageIOWriter(this);

	requestFilter: (msg: RequestMessage) => RequestMessage | false = (msg) => msg;
	responseFilter: (msg: ResponseMessage) => ResponseMessage | false = (msg) => msg;
	notificationFilter: (msg: NotificationMessage) => NotificationMessage | false = (msg) => msg;

	socket?: Socket;
	messageCache: string[] = [];

	async connect(host: string, port: number): Promise<void> {
		log.debug(`connecting to ${host}:${port}`);
		return new Promise((resolve, _reject) => {
			this.socket = undefined;

			const socket = new Socket();
			socket.connect(port, host);

			socket.on("connect", () => {
				this.socket = socket;

				while (this.messageCache.length > 0) {
					const msg = this.messageCache.shift();
					if (msg === undefined) {
						break;
					}
					this.socket.write(msg);
				}

				this.emit("connected");
				resolve();
			});
			socket.on("data", (chunk: Buffer) => {
				this.emit("data", chunk);
			});
			socket.on("error", () => {
				this.socket = undefined;
			});
			socket.on("close", () => {
				this.socket = undefined;
				this.emit("disconnected");
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
}

export class MessageIOReader extends AbstractMessageReader implements MessageReader, MessageBufferListener {
	/** Set by `listen`; the reader delivers every complete message through it. */
	private callback: DataCallback = () => {};
	private buffer = new MessageBuffer(this);

	constructor(public io: MessageIO) {
		super();
	}

	/** Forwards a stalled message to the jsonrpc listener (see `MessageBufferListener`). */
	notifyPartialMessage(message: { messageToken: number; waitingTime: number }): void {
		this.firePartialMessage(message);
	}

	listen(callback: DataCallback): Disposable {
		this.buffer.reset();

		this.callback = callback;

		this.io.on("data", this.on_data.bind(this));
		this.io.on("error", this.fireError.bind(this));
		this.io.on("close", this.fireClose.bind(this));
		return { dispose() {} };
	}

	private on_data(data: Buffer | string): void {
		this.buffer.append(data);
		for (let message = this.buffer.ready(); message !== undefined; message = this.buffer.ready()) {
			const json: Message = JSON.parse(message);
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
