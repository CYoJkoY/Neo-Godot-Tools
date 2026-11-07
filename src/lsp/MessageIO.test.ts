import { strict as assert } from "node:assert";
import { once } from "node:events";
import { createServer } from "node:net";
import { describe, it } from "node:test";
import { MessageIO } from "./MessageIO.js";

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
});
