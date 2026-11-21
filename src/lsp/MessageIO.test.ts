import { strict as assert } from "node:assert";
import { once } from "node:events";
import { createServer, type Server, type Socket } from "node:net";
import { describe, it } from "node:test";
import type { Message } from "vscode-jsonrpc";
import { MessageIO } from "./MessageIO.js";

const delay = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

/** Frames `message` the way the language server writes it to the socket. */
const frame = (message: unknown): Buffer => {
	const json = JSON.stringify(message);
	return Buffer.from(`Content-Length: ${Buffer.byteLength(json, "utf-8")}\r\n\r\n${json}`, "utf-8");
};

/** Frames a body verbatim, so a test can send a payload that is not valid JSON. */
const raw_frame = (body: string): Buffer =>
	Buffer.from(`Content-Length: ${Buffer.byteLength(body, "utf-8")}\r\n\r\n${body}`, "utf-8");

type TestServer = { server: Server; port: number; connections: Socket[]; close: () => void };

/** Accepts connections and keeps them open until the test closes the server. */
async function start_server(): Promise<TestServer> {
	const connections: Socket[] = [];
	const server = createServer((socket) => connections.push(socket));
	await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
	const address = server.address();
	assert.ok(address && typeof address !== "string");
	return { server, port: address.port, connections, close: () => server.close() };
}

describe("MessageIO", () => {
	it("forwards socket closure to the JSON-RPC reader", async () => {
		const server = createServer((socket) => socket.end());
		await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
		const address = server.address();
		assert.ok(address && typeof address !== "string");

		const io = new MessageIO();
		const disconnected = once(io, "disconnected");
		const closed = once(io, "close");
		try {
			await io.connect("127.0.0.1", address.port);
			await Promise.all([disconnected, closed]);
		} finally {
			server.close();
		}
	});

	it("settles the connect promise when the server closes during the handshake", async () => {
		const server = createServer((socket) => socket.destroy());
		await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
		const address = server.address();
		assert.ok(address && typeof address !== "string");

		const io = new MessageIO();
		try {
			await io.connect("127.0.0.1", address.port);
		} finally {
			server.close();
		}
	});

	it("ignores the closure of a connection that was replaced", async () => {
		const first = await start_server();
		const second = await start_server();
		const io = new MessageIO();
		let closed = 0;
		let disconnected = 0;
		io.on("close", () => closed++);
		io.on("disconnected", () => disconnected++);
		try {
			await io.connect("127.0.0.1", first.port);
			await io.connect("127.0.0.1", second.port);

			// The replaced socket reports its closure; it must not be mistaken for
			// the connection that is in use.
			for (const socket of first.connections) socket.destroy();
			await delay(50);

			assert.equal(closed, 0);
			assert.equal(disconnected, 0);
			assert.equal(io.socket?.remotePort, second.port);
		} finally {
			// The active socket is still open; leaving it connected keeps Node's
			// event loop alive and stalls the test process after the last test.
			io.socket?.destroy();
			for (const socket of second.connections) socket.destroy();
			first.close();
			second.close();
		}
	});

	it("delivers each message once when the reader listens again", () => {
		const io = new MessageIO();
		const received: string[] = [];
		const record = (message: Message): void => {
			if ("method" in message && typeof message.method === "string") received.push(message.method);
		};
		io.reader.listen(record);
		io.reader.listen(record);

		io.emit("data", frame({ jsonrpc: "2.0", method: "gdscript/capabilities" }));

		assert.deepEqual(received, ["gdscript/capabilities"]);
	});

	it("stops delivering when the reader registration is disposed", () => {
		const io = new MessageIO();
		const received: string[] = [];
		const record = (message: Message): void => {
			if ("method" in message && typeof message.method === "string") received.push(message.method);
		};
		const registration = io.reader.listen(record);
		io.emit("data", frame({ jsonrpc: "2.0", method: "first" }));
		registration.dispose();
		io.emit("data", frame({ jsonrpc: "2.0", method: "second" }));

		assert.deepEqual(received, ["first"]);
	});

	it("discards a frame left behind by a previous connection", () => {
		const io = new MessageIO();
		const received: string[] = [];
		const record = (message: Message): void => {
			if ("method" in message && typeof message.method === "string") received.push(message.method);
		};
		const first = io.reader.listen(record);
		// A connection dropped mid-message leaves a header without its body.
		io.emit("data", frame({ jsonrpc: "2.0", method: "stale" }).subarray(0, 20));
		first.dispose();

		const second = io.reader.listen(record);
		io.emit("data", frame({ jsonrpc: "2.0", method: "fresh" }));

		assert.deepEqual(received, ["fresh"]);
		second.dispose();
	});

	it("reports an undecodable frame instead of throwing", () => {
		const io = new MessageIO();
		const registration = io.reader.listen(() => {});
		let reported = 0;
		io.reader.onError(() => reported++);

		assert.doesNotThrow(() => io.emit("data", raw_frame("{oops")));
		// A well-formed but non-object payload desynchronizes the stream as well.
		assert.doesNotThrow(() => io.emit("data", raw_frame("42")));

		assert.equal(reported, 2);
		registration.dispose();
	});

	it("keeps delivering after the reader was disposed by a stopped client", () => {
		const io = new MessageIO();
		const received: string[] = [];
		const record = (message: Message): void => {
			if ("method" in message && typeof message.method === "string") received.push(message.method);
		};
		// Stopping a client disposes the reader through its JSON-RPC connection;
		// starting it again reuses the same reader for the new connection.
		io.reader.listen(record).dispose();
		io.reader.dispose();

		const registration = io.reader.listen(record);
		io.emit("data", frame({ jsonrpc: "2.0", method: "restarted" }));

		assert.deepEqual(received, ["restarted"]);
		registration.dispose();
	});
});
