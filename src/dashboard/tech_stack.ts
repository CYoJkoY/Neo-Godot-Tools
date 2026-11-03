/**
 * Static map of the implementation languages and runtimes in Neo Godot Tools.
 *
 * The dashboard renders this list without asking the native sidecar, so the
 * map stays available when the binary is missing or fails its handshake.
 */

export interface TechnologyMapEntry {
	readonly component: string;
	readonly technology: string;
	readonly sources: readonly string[];
}

export const technologyMap: readonly TechnologyMapEntry[] = [
	{
		component: "Extension host and language providers",
		technology: "TypeScript, Node.js, VS Code API",
		sources: ["src/extension.ts", "src/providers/"],
	},
	{
		component: "GDScript analysis and project index",
		technology: "TypeScript",
		sources: ["src/analyzer/", "src/index/", "src/language/"],
	},
	{
		component: "Native analysis sidecar",
		technology: "Zig 0.17.0, JSON-RPC 2.0 over stdio",
		sources: ["backend/src/"],
	},
	{
		component: "Native symbol mirror",
		technology: "TypeScript adapter, Zig symbol store",
		sources: ["src/backend/zig_backend.ts", "src/index/zig_symbol_mirror.ts"],
	},
	{
		component: "Editors, previews and inspectors",
		technology: "TypeScript host, HTML/CSS/vanilla JavaScript webviews",
		sources: ["src/dashboard/", "src/resource_inspector/", "src/scene_tools/"],
	},
	{
		component: "Godot language server integration",
		technology: "TypeScript, TCP/JSON-RPC",
		sources: ["src/lsp/"],
	},
	{
		component: "Godot debugger",
		technology: "TypeScript, Debug Adapter Protocol",
		sources: ["src/debugger/"],
	},
	{
		component: "Syntax highlighting",
		technology: "TextMate JSON grammars",
		sources: ["syntaxes/"],
	},
	{
		component: "Build, tests and CI",
		technology: "Node.js, TypeScript, Zig build, GitHub Actions YAML",
		sources: ["package.json", "backend/build.zig", ".github/workflows/"],
	},
];

const HTML_ENTITIES: Readonly<Record<string, string>> = {
	"&": "&amp;",
	"<": "&lt;",
	">": "&gt;",
	'"': "&quot;",
	"'": "&#39;",
};

const escapeHtml = (value: string): string =>
	value.replace(/[&<>"']/g, (character) => HTML_ENTITIES[character] ?? character);

/** Table body for the dashboard; every value is static and HTML escaped. */
export const technologyMapHtml = (): string =>
	technologyMap
		.map(
			(entry) => `			<tr class="tech-row">
				<td>${escapeHtml(entry.component)}</td>
				<td class="technology">${escapeHtml(entry.technology)}</td>
				<td class="paths">${entry.sources.map((source) => `<code>${escapeHtml(source)}</code>`).join(" ")}</td>
			</tr>`,
		)
		.join("\n");
