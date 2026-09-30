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

const { spawnSync } = require("node:child_process");
const fs = require("node:fs");
const path = require("node:path");

const ROOT = path.resolve(__dirname, "..");
const BUILD_DIR = path.join(ROOT, "out-test");
const STUB_REGISTER = path.join(__dirname, "vscode_stub_register.cjs");

const HOST_ONLY_TESTS = new Set([
	"debugger/godot4/variables/debugger_variables.test.js",
	"formatter/formatter.test.js",
]);

function collect_tests(directory, result = []) {
	for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
		const full = path.join(directory, entry.name);
		if (entry.isDirectory()) {
			collect_tests(full, result);
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

const relative = (file) => path.relative(BUILD_DIR, file).split(path.sep).join("/");
const tests = collect_tests(BUILD_DIR)
	.filter((file) => !HOST_ONLY_TESTS.has(relative(file)))
	.sort();

if (!tests.length) {
	console.error("No test files found in out-test.");
	process.exit(1);
}

console.log(`Running ${tests.length} unit test files (skipping ${HOST_ONLY_TESTS.size} extension-host tests).`);

const result = spawnSync(
	process.execPath,
	["--require", STUB_REGISTER, "--test", "--test-reporter=spec", ...tests],
	{ cwd: ROOT, stdio: "inherit" },
);

process.exit(result.status ?? 1);
