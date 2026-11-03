import { strict as assert } from "node:assert";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { describe, it } from "node:test";
import { clean_godot_path, get_editor_data_dir, verify_godot_version } from "./godot_utils.js";

describe("clean_godot_path", () => {
	it("expands an environment variable reference", () => {
		process.env["NEO_GODOT_TEST_PATH"] = path.join(os.tmpdir(), "godot-test");
		assert.equal(clean_godot_path("${env:NEO_GODOT_TEST_PATH}"), path.join(os.tmpdir(), "godot-test"));
		process.env["NEO_GODOT_TEST_PATH"] = undefined;
	});

	it("strips surrounding quotes", () => {
		const target = path.join(os.tmpdir(), "godot test", "godot.exe");
		assert.equal(clean_godot_path(`"${target}"`), target);
	});

	it("expands a leading home directory marker", () => {
		assert.equal(clean_godot_path("~/bin/godot"), path.join(os.homedir(), "bin", "godot"));
	});

	it("keeps an unset variable visible instead of silently emptying the path", () => {
		assert.equal(clean_godot_path("${env:NEO_GODOT_UNSET}${env:NEO_GODOT_UNSET}"), "${env:NEO_GODOT_UNSET}${env:NEO_GODOT_UNSET}");
	});
});

describe("get_editor_data_dir", () => {
	it("points at the platform directory that holds editor_settings", () => {
		const dir = get_editor_data_dir();
		const expected =
			process.platform === "win32"
				? path.join(process.env["APPDATA"] ?? "", "Godot")
				: process.platform === "darwin"
					? path.join(os.homedir(), "Library", "Application Support", "Godot")
					: path.join(process.env["XDG_CONFIG_HOME"] || path.join(os.homedir(), ".config"), "godot");
		assert.equal(dir, expected);
	});
});

describe("verify_godot_version", () => {
	it("keeps the PATH executable instead of replacing it with a workspace path", { skip: process.platform === "win32" }, () => {
		const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ngdt-godot-"));
		const executable = path.join(dir, "godot");
		fs.writeFileSync(executable, "#!/bin/sh\necho '4.4.1.stable.official'\n");
		fs.chmodSync(executable, 0o755);
		const originalPath = process.env["PATH"];
		process.env["PATH"] = `${dir}${path.delimiter}${originalPath ?? ""}`;
		try {
			const result = verify_godot_version("godot", "4");
			assert.equal(result.status, "SUCCESS");
			assert.equal(result.godotPath, "godot", "the bare name resolves through PATH at launch time too");
		} finally {
			process.env["PATH"] = originalPath;
			fs.rmSync(dir, { recursive: true, force: true });
		}
	});

	it("keeps an absolute executable path", () => {
		const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ngdt-godot-"));
		const executable = path.join(dir, "godot.exe");
		fs.writeFileSync(executable, "");
		try {
			const result = verify_godot_version(executable, "4");
			assert.equal(result.status, "INVALID_EXE");
			assert.equal(result.godotPath, executable);
		} finally {
			fs.rmSync(dir, { recursive: true, force: true });
		}
	});
});
