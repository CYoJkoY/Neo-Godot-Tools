import * as path from "node:path";

/**
 * Whether the root reported by the Godot language server and the directory that
 * holds the workspace `project.godot` denote the same workspace.
 *
 * Godot decides the same question in `GDScriptLanguageProtocol::initialize`:
 * `rootPath` is compared with the editor project root after replacing `\` with
 * `/` and lowercasing both sides. Mirroring those rules matters because a
 * stricter comparison here disconnects a healthy connection: the server reports
 * `gdscript_client/changeWorkspace` whenever its own comparison fails, and a
 * rejection in the middle of the `initialize` handshake tears the JSON-RPC
 * connection down (see the startup failure reported as
 * "Pending response rejected since connection got disposed").
 *
 * A client path nested inside the reported root is accepted: Godot reports the
 * editor project root, while the workspace may be opened on one of its
 * subfolders. An unknown client path is accepted as well, because rejecting on
 * missing information discards a connection that may be perfectly usable.
 */
export function is_same_workspace(
	server_path: string | undefined,
	client_path: string | undefined,
	platform: NodeJS.Platform = process.platform,
): boolean {
	const server = normalize(server_path, platform);
	if (server === undefined) return true;
	const client = normalize(client_path, platform);
	if (client === undefined) return true;
	if (client === server) return true;
	return is_nested(client, server);
}

/** Case-insensitive file systems: Windows (Godot lowercases) and macOS APFS. */
const is_case_insensitive = (platform: NodeJS.Platform): boolean => platform === "win32" || platform === "darwin";

/**
 * Absolute, separator-normalized, `/`-joined form of `value`, or `undefined`
 * when the path is missing, empty, or relative (and therefore not comparable
 * with the absolute path a server reports).
 */
function normalize(value: string | undefined, platform: NodeJS.Platform): string | undefined {
	if (value === undefined || value.length === 0) return undefined;
	const paths = platform === "win32" ? path.win32 : path.posix;
	if (!paths.isAbsolute(value)) return undefined;
	const resolved = paths.resolve(value).replace(/\\/g, "/");
	// `resolve` keeps a trailing separator; a root ("/", "e:/") must keep it.
	const trimmed = resolved.replace(/\/+$/, "");
	const normalized = trimmed.length === 0 || /^[a-zA-Z]:$/.test(trimmed) ? `${trimmed}/` : trimmed;
	return is_case_insensitive(platform) ? normalized.toLowerCase() : normalized;
}

/** Whether `child` is `parent` or one of its descendants. */
function is_nested(child: string, parent: string): boolean {
	const prefix = parent.endsWith("/") ? parent : `${parent}/`;
	return child.startsWith(prefix);
}
