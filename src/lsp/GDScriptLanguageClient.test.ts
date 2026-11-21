import { strict as assert } from "node:assert";
import { once } from "node:events";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createServer, type Server, type Socket } from "node:net";
import { tmpdir } from "node:os";
import * as path from "node:path";
import { after, before, describe, it } from "node:test";
import { Uri, __configuration, workspace } from "../../tools/vscode_stub.js";
import { __defer_client_start, __fail_client_start } from "../../tools/vscode_languageclient_stub.js";
import GDScriptLanguageClient, { ClientStatus, TargetLSP } from "./GDScriptLanguageClient.js";

const delay = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

/** Polls `predicate` because socket teardown reports its result asynchronously. */
async function wait_for(predicate: () => boolean, timeoutMs = 2000): Promise<void> {
	const started = Date.now();
	while (!predicate()) {
		if (Date.now() - started > timeoutMs) throw new Error("timed out waiting for the expected state");
		await delay(10);
	}
}

type TestServer = { server: Server; port: number; connections: Socket[] };

/** An accepting server that keeps accepted sockets open. */
async function start_server(): Promise<TestServer> {
	const connections: Socket[] = [];
	const server = createServer((socket) => {
		// A client that drops its side resets the connection; without a listener
		// the server socket would report it as an uncaught error after the test.
		socket.on("error", () => {});
		connections.push(socket);
	});
	await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
	const address = server.address();
	assert.ok(address && typeof address !== "string");
	return { server, port: address.port, connections };
}

const change_workspace = (root: string) => ({
	jsonrpc: "2.0",
	method: "gdscript_client/changeWorkspace",
	params: { path: root },
});

/** The reported root with separators and case varied the way Godot may report it. */
const variant_of = (root: string): string => {
	const trailing = `${root.replace(/\\/g, "/")}/`;
	return process.platform === "linux" ? trailing : trailing.toLowerCase();
};

describe("GDScriptLanguageClient workspace handshake", () => {
	let project_root = "";
	let project_server: TestServer;
	let clients: GDScriptLanguageClient[] = [];

	before(async () => {
		project_root = mkdtempSync(path.join(tmpdir(), "neo-godot-lsp-"));
		writeFileSync(path.join(project_root, "project.godot"), "config_version=5\n");
		const subfolder = path.join(project_root, "scripts");
		mkdirSync(subfolder);
		// `find_project_file` walks up from the workspace folder, so opening a
		// subfolder still resolves the enclosing project.
		workspace.workspaceFolders = [{ uri: Uri.file(subfolder), name: "project", index: 0 }];
		project_server = await start_server();
		__configuration["neoGodotTools.lsp.serverPort"] = project_server.port;
	});

	after(() => {
		for (const client of clients) client.io.socket?.destroy();
		clients = [];
		for (const socket of project_server.connections) socket.destroy();
		project_server.server.close();
		rmSync(project_root, { recursive: true, force: true });
	});

	/** A client connected to the test server, with no `start` issued yet. */
	async function connected_client(): Promise<GDScriptLanguageClient> {
		const client = new GDScriptLanguageClient();
		clients.push(client);
		const connected = once(client.io, "connected");
		client.connect(TargetLSP.EDITOR);
		await connected;
		return client;
	}

	it("keeps the connection when the server reports the same workspace", async () => {
		const client = await connected_client();
		client.io.notificationFilter(change_workspace(variant_of(project_root)));
		await delay(50);

		assert.equal(client.status, ClientStatus.CONNECTED);
		assert.ok(client.io.socket, "the transport must stay open");
	});

	it("rejects a mismatched workspace after the handshake settles", async () => {
		const client = await connected_client();
		const release = __defer_client_start();
		const starting = client.start();

		client.io.notificationFilter(change_workspace(path.join(tmpdir(), "neo-godot-lsp-other")));
		// The socket must survive while `initialize` is in flight: disposing it then
		// rejects the pending request instead of reporting the mismatch.
		await delay(50);
		assert.equal(client.status, ClientStatus.CONNECTED);
		assert.ok(client.io.socket, "the transport must not be dropped mid-handshake");

		release();
		await starting;
		await wait_for(() => client.status === ClientStatus.REJECTED);
		assert.equal(client.io.socket, undefined);
	});

	it("drops the transport when the handshake fails", async () => {
		const client = await connected_client();
		__fail_client_start("boom");

		await assert.rejects(client.start(), /boom/);
		await wait_for(() => client.io.socket === undefined && client.status === ClientStatus.DISCONNECTED);
	});
});
