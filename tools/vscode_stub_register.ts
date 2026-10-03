/**
 * Redirect `require("vscode")` to the local stub so unit tests can load modules
 * that import the VS Code API without running inside an extension host.
 *
 * Usage: `node --require out-test/tools/vscode_stub_register.js --test out-test/src`
 *
 * The module is compiled from TypeScript like the rest of the tooling; it is
 * loaded through `--require`, so it must stay CommonJS.
 */

import * as path from "node:path";

const STUB = path.join(__dirname, "vscode_stub.js");
const LANGUAGE_CLIENT_STUB = path.join(__dirname, "vscode_languageclient_stub.js");

type ResolveFilename = (request: string, ...rest: unknown[]) => string;
// `require` keeps the live module object; the namespace import would be a
// read-only copy, and the resolver below must be replaced in place.
const loader = require("node:module") as { _resolveFilename: ResolveFilename };
const originalResolve = loader._resolveFilename;

loader._resolveFilename = function resolveFilename(request: string, ...rest: unknown[]): string {
	if (request === "vscode") return STUB;
	if (request === "vscode-languageclient" || request.startsWith("vscode-languageclient/"))
		return LANGUAGE_CLIENT_STUB;
	return originalResolve.call(this, request, ...rest);
};
