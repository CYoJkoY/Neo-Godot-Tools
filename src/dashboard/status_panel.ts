/**
 * Webview panel that reports what the shared Zig sidecar is doing.
 *
 * The panel observes the backend the extension already uses for workspace
 * symbols. It never spawns a second process, so the counters represent real
 * work and closing the tab cannot stop the backend under the language service.
 * The document itself is dependency free; the extension host only forwards
 * the status payload.
 */

import * as vscode from "vscode";
import type { ZigBackend } from "../backend/zig_backend.js";
import { createLogger } from "../utils/index.js";
import { backendStatusHtml } from "./panel_html.js";

const log = createLogger("dashboard.status");

interface PanelMessage {
	command?: string;
}

interface PanelState {
	panel: vscode.WebviewPanel | undefined;
	/** Serializes status requests so a burst of clicks cannot interleave. */
	queue: Promise<void>;
}

export interface BackendStatusPanel {
	show(): Promise<void>;
	dispose(): void;
}

const describe_error = (error: unknown): string => (error instanceof Error ? error.message : String(error));

export function createBackendStatusPanel(context: vscode.ExtensionContext, backend: ZigBackend): BackendStatusPanel {
	const state: PanelState = { panel: undefined, queue: Promise.resolve() };

	const post = (message: unknown): void => {
		void state.panel?.webview.postMessage(message);
	};

	const run_refresh = async (): Promise<void> => {
		try {
			post({ type: "status", status: await backend.status() });
		} catch (error) {
			log.debug("status request failed:", error);
			post({ type: "error", message: describe_error(error) });
		}
	};

	const refresh = (): Promise<void> => {
		const next = state.queue.then(run_refresh, run_refresh);
		state.queue = next;
		return next;
	};

	const create_panel = (): vscode.WebviewPanel => {
		const created = vscode.window.createWebviewPanel(
			"neoGodotTools.backendStatus",
			"Architecture and Native Backend",
			vscode.ViewColumn.Beside,
			{ enableScripts: true, retainContextWhenHidden: true },
		);
		created.webview.html = backendStatusHtml();
		created.webview.onDidReceiveMessage((message: PanelMessage) => {
			if (message.command === "ready" || message.command === "refresh") void refresh();
		});
		created.onDidDispose(() => {
			if (state.panel !== created) return;
			state.panel = undefined;
		});
		context.subscriptions.push(created);
		return created;
	};

	/**
	 * A new panel refreshes on its own `ready` message: the webview has no
	 * listener yet when `createWebviewPanel` returns, so posting now would be
	 * dropped. An existing panel only needs the numbers to be current again.
	 */
	const show = async (): Promise<void> => {
		const existing = state.panel;
		if (existing === undefined) {
			state.panel = create_panel();
			return;
		}
		existing.reveal(vscode.ViewColumn.Beside, true);
		await refresh();
	};

	const dispose = (): void => {
		const active = state.panel;
		state.panel = undefined;
		active?.dispose();
	};

	return { show, dispose };
}
