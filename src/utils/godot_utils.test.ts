import { strict as assert } from "node:assert";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { describe, it, mock } from "node:test";
import {
	clean_godot_path,
	find_project_file,
	get_editor_data_dir,
	project_resource_path,
	project_dir_for,
	resolve_resource_file,
	verify_godot_version,
} from "./godot_utils.js";
import * as vscode from "vscode";

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

describe("find_project_file", () => {
	it("prefers the nearest project.godot above a scene", () => {
		const root = fs.mkdtempSync(path.join(os.tmpdir(), "ngdt-project-file-"));
		try {
			fs.writeFileSync(path.join(root, "project.godot"), "config_version=4\n");
			const nested = path.join(root, "game", "scenes");
			fs.mkdirSync(nested, { recursive: true });
			fs.writeFileSync(path.join(root, "game", "project.godot"), "config_version=5\n");
			assert.equal(find_project_file(path.join(nested, "main.tscn")), path.join(root, "game", "project.godot"));
		} finally {
			fs.rmSync(root, { recursive: true, force: true });
		}
	});

	it("returns null when no project.godot exists above the file", () => {
		const root = fs.mkdtempSync(path.join(os.tmpdir(), "ngdt-project-file-"));
		try {
			assert.equal(find_project_file(path.join(root, "loose.tscn")), null);
		} finally {
			fs.rmSync(root, { recursive: true, force: true });
		}
	});
});

describe("project_dir_for", () => {
	it("resolves a nested scene against its own project instead of the workspace root", () => {
		const workspace = fs.mkdtempSync(path.join(os.tmpdir(), "ngdt-project-dir-"));
		try {
			const project = path.join(workspace, "game");
			fs.mkdirSync(project, { recursive: true });
			fs.writeFileSync(path.join(project, "project.godot"), "config_version=4\n");
			mock.method(vscode.workspace, "getWorkspaceFolder", () => ({
				uri: vscode.Uri.file(workspace),
				name: "workspace",
				index: 0,
			}));
			assert.equal(project_dir_for(path.join(project, "scenes", "main.tscn")), project);
		} finally {
			mock.restoreAll();
			fs.rmSync(workspace, { recursive: true, force: true });
		}
	});

	it("falls back to the workspace folder for a scene outside any project", () => {
		const workspace = fs.mkdtempSync(path.join(os.tmpdir(), "ngdt-project-dir-"));
		try {
			mock.method(vscode.workspace, "getWorkspaceFolder", () => ({
				uri: vscode.Uri.file(workspace),
				name: "workspace",
				index: 0,
			}));
			// The stub's `Uri.file` normalizes separators, so compare against the same uri.
			assert.equal(project_dir_for(path.join(workspace, "loose.tscn")), vscode.Uri.file(workspace).fsPath);
		} finally {
			mock.restoreAll();
			fs.rmSync(workspace, { recursive: true, force: true });
		}
	});

	it("uses the real project when the workspace folder is one of its subdirectories", () => {
		const project = fs.mkdtempSync(path.join(os.tmpdir(), "ngdt-project-dir-"));
		try {
			const workspace = path.join(project, "scenes");
			fs.mkdirSync(workspace, { recursive: true });
			fs.writeFileSync(path.join(project, "project.godot"), "config_version=4\n");
			mock.method(vscode.workspace, "getWorkspaceFolder", () => ({
				uri: vscode.Uri.file(workspace),
				name: "workspace",
				index: 0,
			}));
			assert.equal(project_dir_for(path.join(workspace, "main.tscn")), project);
		} finally {
			mock.restoreAll();
			fs.rmSync(project, { recursive: true, force: true });
		}
	});
});

describe("resolve_resource_file", () => {
	it("maps res:// onto the owning project and rejects other schemes", () => {
		const root = fs.mkdtempSync(path.join(os.tmpdir(), "ngdt-resource-file-"));
		try {
			const project = path.join(root, "game");
			fs.mkdirSync(path.join(project, "scenes"), { recursive: true });
			fs.writeFileSync(path.join(project, "project.godot"), "config_version=4\n");
			const scene = path.join(project, "scenes", "main.tscn");
			assert.equal(resolve_resource_file(scene, "res://player.gd"), path.join(project, "player.gd"));
			assert.equal(resolve_resource_file(scene, "user://player.gd"), undefined);
			assert.equal(resolve_resource_file(scene, "../player.gd"), undefined);
		} finally {
			fs.rmSync(root, { recursive: true, force: true });
		}
	});

	it("never escapes the project root with res://..", () => {
		const root = fs.mkdtempSync(path.join(os.tmpdir(), "ngdt-resource-escape-"));
		try {
			const project = path.join(root, "game");
			fs.mkdirSync(project, { recursive: true });
			fs.writeFileSync(path.join(project, "project.godot"), "config_version=4\n");
			fs.writeFileSync(path.join(root, "outside.gd"), "extends Node2D\n");
			const scene = path.join(project, "main.tscn");
			assert.equal(resolve_resource_file(scene, "res://../outside.gd"), undefined);
			assert.equal(resolve_resource_file(scene, "res://scenes/../player.gd"), path.join(project, "player.gd"));
			assert.equal(resolve_resource_file(scene, "res://"), undefined, "the project root is not a resource");
		} finally {
			fs.rmSync(root, { recursive: true, force: true });
		}
	});
});

describe("project_resource_path", () => {
	it("keeps files inside the owning project as res:// and rejects paths outside it", () => {
		const root = fs.mkdtempSync(path.join(os.tmpdir(), "ngdt-resource-path-"));
		try {
			const project = path.join(root, "game");
			fs.mkdirSync(path.join(project, "scenes"), { recursive: true });
			fs.writeFileSync(path.join(project, "project.godot"), "config_version=4\n");
			const scene = path.join(project, "scenes", "main.tscn");
			assert.equal(
				project_resource_path(scene, path.join(project, "assets", "icon.png")),
				"res://assets/icon.png",
			);
			assert.equal(project_resource_path(scene, scene), "res://scenes/main.tscn");
			assert.equal(project_resource_path(scene, project), undefined, "the project root has no res:// form");
			assert.equal(project_resource_path(scene, path.join(root, "outside.png")), undefined);
		} finally {
			fs.rmSync(root, { recursive: true, force: true });
		}
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
