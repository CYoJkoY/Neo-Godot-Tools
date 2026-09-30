/**
 * Redirect `require("vscode")` to the local stub so unit tests can load modules
 * that import the VS Code API without running inside an extension host.
 *
 * Usage: `node --require tools/vscode_stub_register.cjs --test out-test`
 */

const Module = require("node:module");
const path = require("node:path");

const STUB = path.join(__dirname, "vscode_stub.cjs");
const LANGUAGE_CLIENT_STUB = path.join(__dirname, "vscode_languageclient_stub.cjs");
const originalResolve = Module._resolveFilename;

Module._resolveFilename = function resolveFilename(request, ...rest) {
	if (request === "vscode") return STUB;
	if (request === "vscode-languageclient" || request.startsWith("vscode-languageclient/")) return LANGUAGE_CLIENT_STUB;
	return originalResolve.call(this, request, ...rest);
};
