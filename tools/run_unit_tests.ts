/**
 * Headless unit test runner.
 *
 * Compiles nothing itself — it runs the JavaScript emitted by
 * `tsc -p tsconfig.test.json` (see `npm run test:unit`) under Node's built-in
 * test runner, with `require("vscode")` redirected to the local stub.
 *
 * Tests that need a real VS Code extension host (formatter snapshots) or a
 * running Godot debug session are excluded here and stay covered by
 * `npm run test:engine`.
 */

import { spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";

const ROOT = path.resolve(__dirname, "..", "..");
/** `tsconfig.test.json` compiles that project under `out-test/src`. */
const BUILD_DIR = path.join(ROOT, "out-test", "src");
const STUB_REGISTER = path.join(ROOT, "out-test", "tools", "vscode_stub_register.js");

const HOST_ONLY_TESTS = new Set([
	"debugger/godot4/variables/debugger_variables.test.js",
	"formatter/formatter.test.js",
]);

function collectTests(directory: string, result: string[] = []): string[] {
	for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
		const full = path.join(directory, entry.name);
		if (entry.isDirectory()) {
			collectTests(full, result);
			continue;
		}
		if (entry.isFile() && entry.name.endsWith(".test.js")) result.push(full);
	}
	return result;
}

if (!fs.existsSync(BUILD_DIR)) {
	console.error(`Missing ${BUILD_DIR}. Run "npm run test:unit" (which compiles the tests first).`);
	process.exit(1);
}

const relative = (file: string) => path.relative(BUILD_DIR, file).split(path.sep).join("/");
const tests = collectTests(BUILD_DIR)
	.filter((file) => !HOST_ONLY_TESTS.has(relative(file)))
	.sort();

if (!tests.length) {
	console.error("No test files found in out-test/src.");
	process.exit(1);
}

console.log(`Running ${tests.length} unit test files (skipping ${HOST_ONLY_TESTS.size} extension-host tests).`);

const result = spawnSync(process.execPath, ["--require", STUB_REGISTER, "--test", "--test-reporter=spec", ...tests], {
	cwd: ROOT,
	stdio: "inherit",
	env: {
		...process.env,
		NEO_GODOT_TOOLS_TEST_EXTENSION_ROOT: process.env.NEO_GODOT_TOOLS_TEST_EXTENSION_ROOT || ROOT,
	},
});

process.exit(result.status ?? 1);
