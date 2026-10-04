import { strict as assert } from "node:assert";
import { describe, it } from "node:test";
import * as vscode from "vscode";
import type { NotificationMessage } from "vscode-jsonrpc";
import { make_docs_uri } from "../utils/index.js";
import { createDocumentationProvider } from "./documentation.js";
import type { GodotNativeClassInfo, GodotNativeSymbol } from "./documentation_types.js";

function fakeContext(): vscode.ExtensionContext {
	return { subscriptions: [] } as unknown as vscode.ExtensionContext;
}

function capabilities(native_classes: GodotNativeClassInfo[]): NotificationMessage {
	return {
		jsonrpc: "2.0",
		method: "gdscript/capabilities",
		params: { native_classes },
	} as unknown as NotificationMessage;
}

function fakePanel(): vscode.WebviewPanel {
	return {
		webview: {
			html: "",
			options: {},
			postMessage: async () => true,
			asWebviewUri: (uri: vscode.Uri) => uri,
			onDidReceiveMessage: () => ({ dispose: () => {} }),
		},
	} as unknown as vscode.WebviewPanel;
}

const SYMBOL = {
	name: "Node",
	kind: 4,
	range: { start: { line: 0, character: 0 }, end: { line: 0, character: 0 } },
	selectionRange: { start: { line: 0, character: 0 }, end: { line: 0, character: 0 } },
	native_class: "Node",
	documentation: "Plain text.",
	children: [],
} as unknown as GodotNativeSymbol;

describe("documentation provider", () => {
	it("indexes the reported classes and their bases", () => {
		const provider = createDocumentationProvider(fakeContext());
		const reported = {
			native_classes: [
				{ name: "Object", inherits: "" },
				{ name: "Node", inherits: "Object" },
				{ name: "Node2D", inherits: "Node" },
				{ name: "MissingBase", inherits: "NotReported" },
			],
		};
		const message = capabilities(reported.native_classes);
		const asSent = JSON.stringify(message);
		provider.register_capabilities(message);

		assert.deepEqual([...provider.classInfo.keys()].sort(), [
			"MissingBase",
			"Node",
			"Node2D",
			"NotReported",
			"Object",
		]);
		assert.deepEqual(provider.classInfo.get("Object")?.extended_classes, ["Node"]);
		assert.deepEqual(provider.classInfo.get("Node")?.extended_classes, ["Node2D"]);
		assert.deepEqual(provider.classInfo.get("MissingBase")?.extended_classes, undefined);
		assert.equal(JSON.stringify(message), asSent, "the capabilities message of the client is left untouched");
	});

	it("renders the class page once per class and focuses the fragment", async () => {
		const requests: string[] = [];
		const provider = createDocumentationProvider(fakeContext(), {
			lsp: () => ({
				sendRequest: async (method: string) => {
					requests.push(method);
					return SYMBOL;
				},
			}),
		});
		provider.register_capabilities(capabilities([{ name: "Node", inherits: "" }]));

		const panel = fakePanel();
		const document = { uri: make_docs_uri("Node", "speed") } as unknown as vscode.CustomDocument;
		await provider.resolveCustomEditor(document, panel, {
			isCancellationRequested: false,
			onCancellationRequested: () => ({ dispose: () => {} }),
		} as unknown as vscode.CancellationToken);

		assert.deepEqual(requests, ["textDocument/nativeSymbol"]);
		assert.match(panel.webview.html, /Class: Node/, "the class page is rendered");
		assert.match(panel.webview.html, /ngdtFocus\("speed"\)/, "the fragment is focused on load");

		const second = fakePanel();
		await provider.resolveCustomEditor(document, second, {
			isCancellationRequested: false,
			onCancellationRequested: () => ({ dispose: () => {} }),
		} as unknown as vscode.CancellationToken);
		assert.deepEqual(requests, ["textDocument/nativeSymbol"], "the page and symbol are cached");
		assert.equal(second.webview.html, panel.webview.html);

		const unknown = fakePanel();
		await provider.resolveCustomEditor(
			{ uri: make_docs_uri("NotAThing") } as unknown as vscode.CustomDocument,
			unknown,
			{
				isCancellationRequested: false,
				onCancellationRequested: () => ({ dispose: () => {} }),
			} as unknown as vscode.CancellationToken,
		);
		assert.deepEqual(requests, ["textDocument/nativeSymbol"], "an unknown class is never requested");
		assert.equal(unknown.webview.html, "", "and leaves the panel empty");
	});
});
