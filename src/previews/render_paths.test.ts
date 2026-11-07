import { strict as assert } from "node:assert";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { describe, it } from "node:test";
import { detectEngineMajor, findProjectRootForEntry, stripAutoloadSections, toResourcePath } from "./render_paths.js";

describe("native render paths", () => {
	it("detects the engine major from config features and config_version", () => {
		assert.equal(
			detectEngineMajor(
				'config_version=5\n[application]\nconfig/features=PackedStringArray("4.4", "GL Compatibility")\n',
			),
			"4",
		);
		assert.equal(
			detectEngineMajor('config_version=4\n[application]\nconfig/features=PackedStringArray("3.6", "GLES3")\n'),
			"3",
		);
		assert.equal(detectEngineMajor("config_version=5\n"), "4", "Godot 4 projects may omit the feature list");
		assert.equal(detectEngineMajor("config_version=4\n"), "3");
		assert.equal(detectEngineMajor(""), "3");
	});

	it("strips autoload sections and keeps the remaining configuration", () => {
		const source = [
			"config_version=5",
			"",
			"[application]",
			'config/name="Sandbox"',
			"",
			"[autoload]",
			'Globals="*res://globals.gd"',
			"",
			"[rendering]",
			'renderer/rendering_method="gl_compatibility"',
		].join("\n");
		assert.equal(
			stripAutoloadSections(source),
			[
				"config_version=5",
				"",
				"[application]",
				'config/name="Sandbox"',
				"",
				"[rendering]",
				'renderer/rendering_method="gl_compatibility"',
			].join("\n"),
		);
		assert.equal(stripAutoloadSections('[autoload]\nA="*res://a.gd"'), "");
	});

	it("finds the nearest project root above a file", () => {
		const root = fs.mkdtempSync(path.join(os.tmpdir(), "ngdt-render-paths-"));
		try {
			const project = path.join(root, "game");
			const nested = path.join(project, "scenes", "levels");
			fs.mkdirSync(nested, { recursive: true });
			fs.writeFileSync(path.join(project, "project.godot"), "config_version=5\n");
			const scene = path.join(nested, "main.tscn");
			fs.writeFileSync(scene, "[gd_scene]\n");
			assert.equal(findProjectRootForEntry(scene), project);
			assert.equal(findProjectRootForEntry(nested), project);
			assert.equal(findProjectRootForEntry(path.join(project, "missing.tscn")), project);
			const outside = fs.mkdtempSync(path.join(os.tmpdir(), "ngdt-render-outside-"));
			try {
				assert.equal(findProjectRootForEntry(path.join(outside, "loose.tscn")), undefined);
			} finally {
				fs.rmSync(outside, { recursive: true, force: true });
			}
		} finally {
			fs.rmSync(root, { recursive: true, force: true });
		}
	});

	it("maps only files inside the project to res:// paths", () => {
		const root = path.resolve(os.tmpdir(), "ngdt-render-project");
		assert.equal(toResourcePath(root, path.join(root, "scenes", "main.tscn")), "res://scenes/main.tscn");
		assert.equal(toResourcePath(root, path.join(root, "main.tscn")), "res://main.tscn");
		assert.equal(toResourcePath(root, root), undefined);
		assert.equal(toResourcePath(root, path.join(path.dirname(root), "elsewhere.tscn")), undefined);
	});
});
