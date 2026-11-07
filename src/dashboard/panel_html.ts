/**
 * HTML/JavaScript for the architecture and native backend dashboard.
 *
 * The page is dependency free. It renders the single `status` payload the
 * extension forwards from the Zig backend, and posts back only `ready` and
 * `refresh`, so every number on screen comes from the native counters.
 */

import { randomBytes } from "node:crypto";
import { technologyMapHtml } from "./tech_stack.js";

const PANEL_SCRIPT = `
const vscode = acquireVsCodeApi();
const versions = document.getElementById("versions");
const uptime = document.getElementById("uptime");
const moduleBody = document.getElementById("module-body");
const moduleTable = document.getElementById("module-table");
const empty = document.getElementById("empty");
const error = document.getElementById("error");
const errorMessage = document.getElementById("error-message");
const scratchLast = document.getElementById("scratch-last");
const scratchPeak = document.getElementById("scratch-peak");
const refreshButton = document.getElementById("refresh");

const post = (command) => vscode.postMessage({ command: command });

const formatMicros = (micros) => {
	const value = typeof micros === "number" ? micros : 0;
	if (value <= 0) return "0";
	if (value < 1000) return (value < 10 ? value.toFixed(1) : value.toFixed(0)) + " us";
	return (value / 1000).toFixed(2) + " ms";
};

const formatUptime = (milliseconds) => {
	const seconds = Math.floor(milliseconds / 1000);
	if (seconds < 60) return "Up " + seconds + "s";
	const minutes = Math.floor(seconds / 60);
	if (minutes < 60) return "Up " + minutes + "m " + (seconds % 60) + "s";
	const hours = Math.floor(minutes / 60);
	return "Up " + hours + "h " + (minutes % 60) + "m";
};

const formatBytes = (bytes) => {
	const value = typeof bytes === "number" ? bytes : 0;
	if (value < 1024) return value + " B";
	if (value < 1048576) return (value / 1024).toFixed(1) + " KiB";
	return (value / 1048576).toFixed(1) + " MiB";
};

const cell = (text, className) => {
	const node = document.createElement("td");
	if (className) node.className = className;
	node.textContent = text;
	return node;
};

const renderModules = (modules) => {
	moduleBody.textContent = "";
	if (!modules.length) {
		moduleTable.hidden = true;
		empty.hidden = false;
		return;
	}
	moduleTable.hidden = false;
	empty.hidden = true;
	modules.forEach((entry) => {
		const row = document.createElement("tr");
		row.appendChild(cell(entry.label));
		row.appendChild(cell(entry.driver, "driver"));
		row.appendChild(cell(String(entry.requests), "num"));
		row.appendChild(cell(formatMicros(entry.meanMicros), "num"));
		row.appendChild(cell(formatMicros(entry.maxMicros), "num"));
		moduleBody.appendChild(row);
	});
};

const render = (status) => {
	error.hidden = true;
	versions.textContent =
		"Backend " + status.backendVersion + "  |  Zig " + status.zigVersion + "  |  Protocol " + status.protocolVersion;
	uptime.textContent = formatUptime(status.uptimeMs);
	renderModules(status.modules);
	scratchLast.textContent = formatBytes(status.scratchLastBytes);
	scratchPeak.textContent = formatBytes(status.scratchPeakBytes);
};

const showError = (message) => {
	error.hidden = false;
	errorMessage.textContent = message;
};

window.addEventListener("message", (event) => {
	const message = event.data;
	if (!message) return;
	if (message.type === "status") render(message.status);
	if (message.type === "error") showError(message.message);
});

refreshButton.addEventListener("click", () => post("refresh"));
post("ready");
`;

/** Builds the dashboard document; the nonce authorizes exactly one script. */
export function backendStatusHtml(): string {
	const nonce = randomBytes(16).toString("hex");
	return /* html */ `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; script-src 'nonce-${nonce}';">
<title>Architecture</title>
<style>
	:root {
		color-scheme: light dark;
		--st-surface: var(--vscode-editor-background);
		--st-card: color-mix(in srgb, #98826b 5%, var(--st-surface));
		--st-border: color-mix(in srgb, var(--vscode-foreground) 14%, transparent);
		--st-muted: var(--vscode-descriptionForeground, #777);
		--st-accent: color-mix(in srgb, #98826b 45%, var(--vscode-button-background, #6f7964));
		--st-radius: 6px;
	}
	* { box-sizing: border-box; }
	body {
		margin: 0; padding: 18px 16px 28px;
		background: var(--st-surface); color: var(--vscode-foreground);
		font-family: var(--vscode-font-family); font-size: var(--vscode-font-size); line-height: 1.45;
	}
	main { max-width: 760px; margin: 0 auto; display: flex; flex-direction: column; gap: 14px; }
	.eyebrow { margin: 0; color: color-mix(in srgb, #98826b 62%, var(--st-muted)); font-size: 10px; font-weight: 600; letter-spacing: .18em; text-transform: uppercase; }
	h1 { margin: 3px 0 0; font-size: 22px; font-weight: 500; font-family: Georgia, "Songti SC", "Noto Serif SC", serif; letter-spacing: .01em; }
	.muted { margin: 4px 0 0; color: var(--st-muted); font-size: 12px; }
	.meta { display: flex; align-items: center; gap: 8px; margin-top: 10px; }
	.badge {
		border: 1px solid var(--st-border); border-radius: 3px; padding: 3px 9px;
		color: var(--st-muted); font-size: 11px; font-variant-numeric: tabular-nums;
	}
	button {
		min-height: 28px; border: 1px solid var(--st-border); border-radius: 3px; padding: 3px 12px;
		background: transparent; color: var(--vscode-foreground); cursor: pointer; font: inherit; font-size: 12px;
	}
	button:hover { background: var(--st-card); }
	button:focus-visible { outline: 2px solid var(--vscode-focusBorder, #1a73e8); outline-offset: 2px; }
	.card { border: 1px solid var(--st-border); border-left: 2px solid color-mix(in srgb, #98826b 42%, transparent); border-radius: var(--st-radius); background: var(--st-card); padding: 14px 16px; }
	.card h2 { margin: 0 0 8px; font-size: 12px; font-weight: 600; letter-spacing: .01em; }
	table { width: 100%; border-collapse: collapse; }
	th {
		padding: 0 0 6px; text-align: left; color: var(--st-muted);
		font-size: 10px; font-weight: 700; letter-spacing: .08em; text-transform: uppercase;
	}
	td { padding: 6px 0; border-top: 1px solid var(--st-border); font-size: 12px; }
	th.num, td.num { text-align: right; font-family: var(--vscode-editor-font-family, monospace); font-variant-numeric: tabular-nums; }
	td.driver { color: var(--st-muted); font-family: var(--vscode-editor-font-family, monospace); font-size: 11px; }
	.stats { display: grid; grid-template-columns: repeat(auto-fit, minmax(140px, 1fr)); gap: 10px; }
	.stat-label {
		display: block; color: var(--st-muted); font-size: 10px;
		font-weight: 700; letter-spacing: .08em; text-transform: uppercase;
	}
	.stat-value { display: block; margin-top: 2px; font-family: var(--vscode-editor-font-family, monospace); font-size: 15px; }
	.hint, .empty { margin: 8px 0 0; color: var(--st-muted); font-size: 11px; }
	.error { border-color: var(--vscode-inputValidation-errorBorder, #be1100); }
	.error h2 { color: var(--vscode-errorForeground, #f48771); }
	.error p { margin: 0; font-size: 12px; overflow-wrap: anywhere; }
	.tech-table th.technology, .tech-table th.paths, .tech-table td.technology, .tech-table td.paths { padding-left: 14px; }
	.tech-table td.technology { white-space: normal; }
	.tech-table td.paths { color: var(--st-muted); font-size: 11px; overflow-wrap: anywhere; }
	.tech-table code { font-family: var(--vscode-editor-font-family, monospace); font-size: 11px; }
	@media (max-width: 560px) {
		.tech-table thead { display: none; }
		.tech-table, .tech-table tbody, .tech-table tr, .tech-table td { display: block; width: 100%; }
		.tech-table tr { padding: 8px 0; border-top: 1px solid var(--st-border); }
		.tech-table tr:first-child { border-top: 0; }
		.tech-table td { padding: 1px 0; border-top: 0; }
		.tech-table td.technology, .tech-table td.paths { padding-left: 0; }
		.tech-table td.technology { color: var(--st-muted); }
	}
</style>
</head>
<body>
<main>
	<header>
		<p class="eyebrow">Neo Godot Tools</p>
		<h1>Architecture and native backend</h1>
		<p id="versions" class="muted">Connecting to the native backend...</p>
		<div class="meta">
			<span id="uptime" class="badge">Uptime -</span>
			<button id="refresh" type="button">Refresh</button>
		</div>
	</header>
	<section class="card">
		<h2>Technology map</h2>
		<p class="hint">Which implementation serves each part of Neo Godot Tools. This map is static and remains visible when the native sidecar is unavailable.</p>
		<table class="tech-table">
			<thead>
				<tr>
					<th>Component</th>
					<th class="technology">Technology</th>
					<th class="paths">Source</th>
				</tr>
			</thead>
			<tbody>
${technologyMapHtml()}
			</tbody>
		</table>
	</section>
	<section class="card">
		<h2>Modules</h2>
		<table id="module-table" hidden>
			<thead>
				<tr>
					<th>Module</th>
					<th>Driver</th>
					<th class="num">Requests</th>
					<th class="num">Mean</th>
					<th class="num">Peak</th>
				</tr>
			</thead>
			<tbody id="module-body"></tbody>
		</table>
		<p id="empty" class="empty">Waiting for the first request...</p>
	</section>
	<section class="card">
		<h2>Transaction scratch arena</h2>
		<div class="stats">
			<div>
				<span class="stat-label">Last request</span>
				<span id="scratch-last" class="stat-value">-</span>
			</div>
			<div>
				<span class="stat-label">Peak capacity</span>
				<span id="scratch-peak" class="stat-value">-</span>
			</div>
		</div>
		<p class="hint">Scratch memory is released after every request; only its capacity is retained.</p>
	</section>
	<section id="error" class="card error" hidden>
		<h2>Backend unavailable</h2>
		<p id="error-message"></p>
	</section>
</main>
<script nonce="${nonce}">
${PANEL_SCRIPT}
</script>
</body>
</html>`;
}
