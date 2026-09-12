#!/usr/bin/env ts-node
import * as fs from "node:fs";
import * as path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { resolve_godot_binary } from "./resolve_godot";

const execFileAsync = promisify(execFile);
const ROOT_DIR = path.resolve(__dirname, "..");
const TEST_PROJECT_GODOT4 = path.join(ROOT_DIR, "test_projects/test-dap-project-godot4");
const VSCODE_TEST_CONFIG = path.join(ROOT_DIR, ".vscode-test.js");

function parse_args(): { version: string; isGodot3: boolean; grep?: string } {
	const args = process.argv.slice(2);
	if (args.length === 0) {
		console.error("Usage: ts-node tools/run_tests.ts <version> [grep pattern] [--godot3]");
		process.exit(1);
	}
	return {
		version: args[0],
		isGodot3: args.includes("--godot3"),
		grep: args.slice(1).find((arg) => !arg.startsWith("--")),
	};
}

function write_test_settings(projectDir: string, settingKey: string, binaryPath: string): void {
	const vscodeDir = path.join(projectDir, ".vscode");
	fs.mkdirSync(vscodeDir, { recursive: true });
	fs.writeFileSync(
		path.join(vscodeDir, "settings.json"),
		`${JSON.stringify({ [settingKey]: binaryPath }, null, 4)}\n`,
	);
}

function write_vscode_test_config(): void {
	fs.writeFileSync(
		VSCODE_TEST_CONFIG,
		"const { defineConfig } = require('@vscode/test-cli');\n\nmodule.exports = defineConfig({\n\tlabel: 'unitTests',\n\tfiles: 'out/**/*.test.js',\n\tlaunchArgs: ['--disable-extensions', '--ozone-platform=x11'],\n\tworkspaceFolder: './test_projects/test-dap-project-godot4',\n});\n",
	);
}

function cleanup_test_config(): void {
	fs.rmSync(VSCODE_TEST_CONFIG, { force: true });
}

async function main(): Promise<void> {
	const { version, isGodot3, grep } = parse_args();
	const binaryPath = resolve_godot_binary(version);
	console.log(`Resolved Godot ${version}: ${binaryPath}`);

	try {
		const { stdout } = await execFileAsync(binaryPath, ["--version"]);
		console.log(`Binary version: ${stdout.trim()}`);
	} catch (error) {
		console.error(`Failed to execute Godot binary: ${error}`);
		process.exit(1);
	}

	const settingKey = isGodot3 ? "neoGodotTools.editorPath.godot3" : "neoGodotTools.editorPath.godot4";
	write_test_settings(TEST_PROJECT_GODOT4, settingKey, binaryPath);

	console.log("Compiling extension...");
	await execFileAsync("npm", ["run", "compile"], { shell: true, cwd: ROOT_DIR });
	console.log("Compilation complete.");
	write_vscode_test_config();

	const testEnv = { ...process.env };
	if (process.env.GODOT_TOOLS_DEBUG !== "false") {
		testEnv.VSCODE_DEBUG_MODE = "true";
	}
	const testArgs = grep ? ["test", "--", "--grep", grep] : ["test"];
	const testProcess = execFile("npm", testArgs, { shell: true, cwd: ROOT_DIR, env: testEnv });
	testProcess.stdout?.pipe(process.stdout);
	testProcess.stderr?.pipe(process.stderr);
	testProcess.on("close", (code) => {
		cleanup_test_config();
		if (code !== 0) {
			console.error(`Tests exited with code ${code}`);
			process.exit(code ?? 1);
		}
		console.log("Tests passed.");
	});
}

main().catch((error) => {
	cleanup_test_config();
	console.error(error);
	process.exit(1);
});
