import { execFileSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import * as vscode from "vscode";
import { createLruCache } from "./lru_cache";

export function get_editor_data_dir(): string {
	// from: https://stackoverflow.com/a/26227660
	const appdata =
		process.env["APPDATA"] ||
		(process.platform === "darwin"
			? `${process.env["HOME"]}/Library/Preferences`
			: `${process.env["HOME"]}/.local/share`);

	return path.join(appdata, "Godot");
}

/** Resolved once per session: the project file and the directory holding it. */
interface ProjectLocation {
	file?: string;
	dir?: string;
}

const projectLocation: ProjectLocation = {};

const is_file = (target: string): boolean => fs.existsSync(target) && fs.statSync(target).isFile();

/** The workspace's `project.godot`: the only match, else the top-most one. */
const locate_workspace_project = async (): Promise<string | undefined> => {
	const files = await vscode.workspace.findFiles("**/project.godot", null);
	if (!files.length) return undefined;
	const best = files.reduce((a, b) => (a.fsPath.length <= b.fsPath.length ? a : b));
	return is_file(best.fsPath) ? best.fsPath : undefined;
};

export async function get_project_dir(): Promise<string | undefined> {
	if (projectLocation.dir && projectLocation.file) {
		return projectLocation.dir;
	}

	const file = await locate_project_file();
	if (!file) return undefined;
	const dir = path.dirname(file);
	// Windows drive letters are reported lowercase by `path.dirname`.
	const normalized = os.platform() === "win32" ? dir.charAt(0).toUpperCase() + dir.slice(1) : dir;
	projectLocation.file = file;
	projectLocation.dir = normalized;
	return normalized;
}

/** Resolution order: the workspace, then walking up from its first folder. */
async function locate_project_file(): Promise<string | undefined> {
	if (vscode.workspace.workspaceFolders === undefined) return undefined;
	const workspace = await locate_workspace_project();
	if (workspace) return workspace;
	const [first] = vscode.workspace.workspaceFolders;
	return first ? (find_project_file(first.uri.fsPath) ?? undefined) : undefined;
}

export async function get_project_file(): Promise<string | undefined> {
	if (projectLocation.dir === undefined || projectLocation.file === undefined) {
		await get_project_dir();
	}
	return projectLocation.file;
}

const projectVersionCache = new Map<string, string>();

/**
 * Reads `config/features` from `project.godot`. Only a 4.x entry counts: Godot 3
 * projects either have no such line or name the branch, and the version is used
 * to pick the debugger and the editor executable, not for display.
 */
const detect_project_version = (text: string): string => {
	const features = text.match(/config\/features=PackedStringArray\((.*)\)/)?.[0];
	return features?.match(/"([0-9]+\.[0-9]+)"/)?.[1] ?? "3.x";
};

export async function get_project_version(): Promise<string | undefined> {
	const file = await get_project_file();
	if (file === undefined) return undefined;
	const cached = projectVersionCache.get(file);
	if (cached) return cached;

	const text = (await vscode.workspace.openTextDocument(file)).getText();
	const version = detect_project_version(text);
	projectVersionCache.set(file, version);
	return version;
}

/** The `depth` parent directories of `start`, closest first, root last. */
const parent_directories = (start: string, depth: number): readonly string[] => {
	const parent = path.dirname(start);
	if (parent === start || depth <= 0) return [];
	return [parent, ...parent_directories(parent, depth - 1)];
};

export function find_project_file(start: string, depth = 20): string | null {
	if (start === ".") {
		return is_file("project.godot") ? "project.godot" : null;
	}
	const found = parent_directories(start, depth + 1).find((directory) =>
		is_file(path.join(directory, "project.godot")),
	);
	return found ? path.join(found, "project.godot") : null;
}

export async function convert_resource_path_to_uri(resPath: string): Promise<vscode.Uri> {
	const dir = await get_project_dir();
	if (!dir) {
		throw new Error("Cannot convert resource path to uri: Could not find project directory");
	}
	return vscode.Uri.joinPath(vscode.Uri.file(dir), resPath.substring("res://".length));
}

export async function convert_uri_to_resource_path(uri: vscode.Uri): Promise<string> {
	const dir = await get_project_dir();
	if (!dir) {
		throw new Error("Cannot convert uri to resource path: Could not find project directory");
	}
	const relative_path = path.normalize(path.relative(dir, uri.fsPath)).split(path.sep).join(path.posix.sep);
	return `res://${relative_path}`;
}

const uidCache = createLruCache<string, vscode.Uri | null>({ capacity: 256 });

/** A cached uid is only usable while the file it points at still exists. */
const cached_uid_uri = (uid: string): vscode.Uri | undefined => {
	const uri = uidCache.get(uid);
	if (uri && fs.existsSync(uri.fsPath)) return uri;
	if (uri) uidCache.delete(uid);
	return undefined;
};

/** Reads every `*.uid` file and caches the resource each one points at. */
async function scan_uid_files(): Promise<ReadonlyMap<string, vscode.Uri>> {
	const files = await vscode.workspace.findFiles("**/*.uid", null);
	const entries = await Promise.all(
		files.map(async (file): Promise<readonly [string, vscode.Uri] | undefined> => {
			const text = (await vscode.workspace.openTextDocument(file)).getText();
			const uid = text.match(/uid:\/\/([0-9a-z]*)/)?.[0];
			if (!uid) return undefined;
			const target = file.fsPath.slice(0, -".uid".length);
			if (!fs.existsSync(target)) return undefined;
			const uri = vscode.Uri.file(target);
			uidCache.set(uid, uri);
			return [uid, uri];
		}),
	);
	return new Map(entries.filter((entry) => entry !== undefined));
}

export async function convert_uids_to_uris(uids: readonly string[]): Promise<Map<string, vscode.Uri>> {
	const requested = uids.filter((uid) => uid.startsWith("uid://"));
	const resolved = new Map(
		requested.flatMap((uid): readonly (readonly [string, vscode.Uri])[] => {
			const uri = cached_uid_uri(uid);
			return uri ? [[uid, uri]] : [];
		}),
	);
	const missing = requested.filter((uid) => !resolved.has(uid));
	if (!missing.length) return resolved;

	const scanned = await scan_uid_files();
	return new Map(
		missing.flatMap((uid): readonly (readonly [string, vscode.Uri])[] => {
			const uri = scanned.get(uid);
			return uri ? [[uid, uri]] : [];
		}),
	);
}

export async function convert_uid_to_uri(uid: string): Promise<vscode.Uri | undefined> {
	const uris = await convert_uids_to_uris([uid]);
	return uris.get(uid);
}

export type VERIFY_STATUS = "SUCCESS" | "WRONG_VERSION" | "INVALID_EXE";
export type VERIFY_RESULT = {
	status: VERIFY_STATUS;
	godotPath: string;
	version?: string;
};

function resolve_windows_executable(target: string): string | undefined {
	if (process.platform !== "win32" || path.isAbsolute(target)) {
		return target;
	}

	try {
		const output = execFileSync("where.exe", [target], {
			encoding: "utf8",
			windowsHide: true,
		}).trim();
		const candidates = output
			.split(/\r?\n/)
			.map((candidate) => candidate.trim())
			.filter((candidate) => candidate.toLowerCase().endsWith(".exe"));
		return candidates.find((candidate) => fs.existsSync(candidate));
	} catch {
		return undefined;
	}
}

/** `undefined` when the executable cannot be run at all. */
function read_executable_version(target: string): string | undefined {
	try {
		return execFileSync(target, ["--version"], { encoding: "utf8", windowsHide: true }).trim();
	} catch {
		return undefined;
	}
}

const against_workspace = (target: string): string =>
	path.resolve(vscode.workspace.workspaceFolders?.[0].uri.fsPath ?? "", target);

export function verify_godot_version(godotPath: string, expectedVersion: "3" | "4" | string): VERIFY_RESULT {
	const cleaned = clean_godot_path(godotPath);
	const target = resolve_windows_executable(cleaned) ?? cleaned;
	// A relative path is tried against the workspace when it is not on PATH.
	const fallback = path.isAbsolute(target) ? target : against_workspace(target);
	const output =
		read_executable_version(target) ?? (fallback === target ? undefined : read_executable_version(fallback));
	if (output === undefined) {
		return { status: "INVALID_EXE", godotPath: fallback };
	}

	const match = output.match(/^(([34])\.([0-9]+)(?:\.[0-9]+)?)/m);
	if (!match) {
		return { status: "INVALID_EXE", godotPath: fallback };
	}
	return match[2] === expectedVersion
		? { status: "SUCCESS", godotPath: fallback, version: match[1] }
		: { status: "WRONG_VERSION", godotPath: fallback, version: match[1] };
}

export function clean_godot_path(godotPath: string): string {
	// `${env:VAR}` lets a setting point at an environment variable.
	const fromEnv = godotPath.match(/\$\{env:(.+?)\}/);
	const unquoted = (fromEnv ? (process.env[fromEnv[1]] ?? "") : godotPath).replace(/^"/, "").replace(/"$/, "");
	return os.platform() === "darwin" && unquoted.endsWith(".app")
		? path.join(unquoted, "Contents", "MacOS", "Godot")
		: unquoted;
}
