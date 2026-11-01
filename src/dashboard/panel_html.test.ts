import { strict as assert } from "node:assert";
import { describe, it } from "node:test";
import * as vm from "node:vm";
import { backendStatusHtml } from "./panel_html.js";

/**
 * The dashboard is plain JavaScript inside the webview document, so the script
 * is exercised in a sandbox with a minimal DOM. The tests pin the parts the
 * user reads: the counters table, the error notice and the two posted commands.
 */

interface StubElement {
	tagName: string;
	className: string;
	hidden: boolean;
	textContent: string;
	children: StubElement[];
	listeners: Record<string, (event?: unknown) => void>;
	appendChild(child: StubElement): StubElement;
	addEventListener(type: string, listener: (event?: unknown) => void): void;
}

interface DashboardSandbox {
	elements: Record<string, StubElement>;
	messages: Array<{ command?: string }>;
	dispatch(message: unknown): void;
}

const stub = (tagName: string): StubElement => {
	const element: StubElement = {
		tagName,
		className: "",
		hidden: false,
		textContent: "",
		children: [],
		listeners: {},
		appendChild(child: StubElement) {
			element.children.push(child);
			return child;
		},
		addEventListener(type: string, listener: (event?: unknown) => void) {
			element.listeners[type] = listener;
		},
	};
	return element;
};

const load = (): DashboardSandbox => {
	const html = backendStatusHtml();
	const script = html.match(/<script[^>]*>([\s\S]*?)<\/script>/)?.[1];
	assert.ok(script, "the dashboard must ship its nonced script");
	const elements: Record<string, StubElement> = {};
	const messages: Array<{ command?: string }> = [];
	let onMessage: ((event?: unknown) => void) | undefined;
	const sandbox = {
		acquireVsCodeApi: () => ({ postMessage: (message: { command?: string }) => messages.push(message) }),
		document: {
			getElementById: (id: string) => {
				elements[id] = elements[id] ?? stub(id);
				return elements[id];
			},
			createElement: (tagName: string) => stub(tagName),
		},
		window: {
			addEventListener: (type: string, listener: (event?: unknown) => void) => {
				if (type === "message") onMessage = listener;
			},
		},
	};
	vm.createContext(sandbox);
	vm.runInContext(script, sandbox);
	return {
		elements,
		messages,
		dispatch: (message: unknown) => onMessage?.({ data: message }),
	};
};

const status = {
	backendVersion: "0.3.0",
	zigVersion: "0.17.0",
	protocolVersion: 1,
	uptimeMs: 65000,
	scratchLastBytes: 2048,
	scratchPeakBytes: 4096,
	modules: [
		{ name: "lexer", label: "Lexer", driver: "zig", requests: 3, meanMicros: 240, maxMicros: 900 },
		{ name: "parser", label: "Parser", driver: "zig", requests: 0, meanMicros: 0, maxMicros: 0 },
	],
};

describe("backend status dashboard", () => {
	it("authorizes only its nonced script and no remote resources", () => {
		const html = backendStatusHtml();
		assert.match(html, /default-src 'none'/);
		assert.match(html, /style-src 'unsafe-inline'/);
		const nonce = html.match(/script-src 'nonce-([a-f0-9]{32})'/)?.[1];
		assert.ok(nonce, "the policy must pin a 16-byte nonce");
		assert.ok(html.includes(`<script nonce="${nonce}">`));
		assert.ok(!html.includes("script-src 'unsafe-inline'"));
		assert.ok(!/https?:\/\//.test(html), "the dashboard must not load remote assets");
	});

	it("asks the extension for status as soon as it loads", () => {
		const dashboard = load();
		assert.deepEqual(
			dashboard.messages.map((message) => message.command),
			["ready"],
		);
		dashboard.elements["refresh"]?.listeners["click"]?.();
		assert.equal(dashboard.messages.at(-1)?.command, "refresh");
	});

	it("renders one row per module with formatted timings", () => {
		const dashboard = load();
		dashboard.dispatch({ type: "status", status });
		const body = dashboard.elements["module-body"];
		assert.equal(body?.children.length, 2);
		const first = body?.children[0];
		assert.deepEqual(
			first?.children.map((cell) => cell.textContent),
			["Lexer", "zig", "3", "240 us", "900 us"],
		);
		assert.equal(dashboard.elements["versions"]?.textContent.includes("0.17.0"), true);
		assert.equal(dashboard.elements["uptime"]?.textContent, "Up 1m 5s");
		assert.equal(dashboard.elements["scratch-last"]?.textContent, "2.0 KiB");
		assert.equal(dashboard.elements["scratch-peak"]?.textContent, "4.0 KiB");
		assert.equal(dashboard.elements["error"]?.hidden, true);
	});

	it("surfaces backend failures without dropping the last good numbers", () => {
		const dashboard = load();
		dashboard.dispatch({ type: "status", status });
		dashboard.dispatch({ type: "error", message: "spawn failed" });
		assert.equal(dashboard.elements["error"]?.hidden, false);
		assert.equal(dashboard.elements["error-message"]?.textContent, "spawn failed");
		assert.equal(dashboard.elements["module-body"]?.children.length, 2);
		dashboard.dispatch({ type: "status", status });
		assert.equal(dashboard.elements["error"]?.hidden, true);
	});
});
