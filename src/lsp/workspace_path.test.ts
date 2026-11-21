import { strict as assert } from "node:assert";
import { describe, it } from "node:test";
import { is_same_workspace } from "./workspace_path.js";

describe("is_same_workspace", () => {
	it("accepts the identical absolute path", () => {
		assert.equal(is_same_workspace("/home/dev/game", "/home/dev/game", "linux"), true);
	});

	it("ignores case and separator differences on Windows", () => {
		assert.equal(is_same_workspace("e:/games/Game", "E:\\Games\\game", "win32"), true);
	});

	it("ignores case differences on macOS", () => {
		assert.equal(is_same_workspace("/Users/dev/Game", "/users/dev/game", "darwin"), true);
	});

	it("keeps case significant on Linux", () => {
		assert.equal(is_same_workspace("/home/dev/Game", "/home/dev/game", "linux"), false);
	});

	it("ignores a trailing separator", () => {
		assert.equal(is_same_workspace("/home/dev/game/", "/home/dev/game", "linux"), true);
	});

	it("resolves relative segments", () => {
		assert.equal(is_same_workspace("/home/dev/game/scripts/..", "/home/dev/game", "linux"), true);
	});

	it("accepts a workspace opened on a subfolder of the project", () => {
		assert.equal(is_same_workspace("/home/dev/game", "/home/dev/game/scripts", "linux"), true);
	});

	it("rejects a sibling that only shares a name prefix", () => {
		assert.equal(is_same_workspace("/home/dev/game/sub", "/home/dev/game/subway", "linux"), false);
	});

	it("rejects an unrelated project", () => {
		assert.equal(is_same_workspace("/home/dev/game", "/home/dev/other", "linux"), false);
	});

	it("accepts when the client path is unknown", () => {
		assert.equal(is_same_workspace("/home/dev/game", undefined, "linux"), true);
		assert.equal(is_same_workspace("/home/dev/game", "", "linux"), true);
	});

	it("accepts when the server path is unknown", () => {
		assert.equal(is_same_workspace(undefined, "/home/dev/game", "linux"), true);
	});

	it("compares drive roots", () => {
		assert.equal(is_same_workspace("E:/", "e:\\", "win32"), true);
	});
});
