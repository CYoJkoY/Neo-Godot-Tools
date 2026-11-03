import { strict as assert } from "node:assert";
import { describe, it } from "node:test";
import {
	build_cmd_start_command,
	build_start_process_script,
	editor_environment,
	quote_windows_argument,
} from "./editor_launch.js";

describe("editor_environment", () => {
	it("removes the Electron Node-mode flag inherited from the extension host", () => {
		const env = editor_environment({ ELECTRON_RUN_AS_NODE: "1", PATH: "/usr/bin", HOME: "/home/me" });
		assert.equal(env["ELECTRON_RUN_AS_NODE"], undefined);
		assert.equal(env["PATH"], "/usr/bin");
		assert.equal(env["HOME"], "/home/me");
	});

	it("leaves the source environment untouched", () => {
		const source: NodeJS.ProcessEnv = { ELECTRON_RUN_AS_NODE: "1" };
		editor_environment(source);
		assert.equal(source["ELECTRON_RUN_AS_NODE"], "1");
	});
});

describe("quote_windows_argument", () => {
	it("leaves arguments without spaces or quotes alone", () => {
		assert.equal(quote_windows_argument("--path"), "--path");
		assert.equal(quote_windows_argument("C:\\Games\\project"), "C:\\Games\\project");
	});

	it("quotes paths containing spaces", () => {
		assert.equal(quote_windows_argument("C:\\My Projects\\Game"), '"C:\\My Projects\\Game"');
	});

	it("escapes embedded quotes", () => {
		assert.equal(quote_windows_argument('say "hi"'), '"say \\"hi\\""');
	});

	it("doubles trailing backslashes before the closing quote", () => {
		assert.equal(quote_windows_argument("C:\\My Projects\\"), '"C:\\My Projects\\\\"');
	});

	it("quotes the empty argument", () => {
		assert.equal(quote_windows_argument(""), '""');
	});
});

describe("build_start_process_script", () => {
	it("passes one quoted argument line so paths with spaces stay intact", () => {
		const script = build_start_process_script(
			"C:\\Godot\\godot.exe",
			["--path", "C:\\My Projects\\Game", "-e"],
			"C:\\My Projects\\Game",
		);
		assert.equal(
			script,
			"Start-Process -FilePath 'C:\\Godot\\godot.exe' " +
				"-ArgumentList '--path \"C:\\My Projects\\Game\" -e' " +
				"-WorkingDirectory 'C:\\My Projects\\Game'",
		);
	});

	it("omits the argument list when there are no arguments", () => {
		const script = build_start_process_script("godot.exe", [], "C:\\Game");
		assert.equal(script, "Start-Process -FilePath 'godot.exe' -WorkingDirectory 'C:\\Game'");
	});
});

describe("build_cmd_start_command", () => {
	it("keeps the working directory and command quoted for spaces", () => {
		const command = build_cmd_start_command("godot.exe", ["--path", "C:\\My Projects"], "C:\\My Projects");
		assert.equal(
			command,
			'/d /s /c start "" /d "C:\\My Projects" godot.exe --path "C:\\My Projects"',
		);
	});
});
