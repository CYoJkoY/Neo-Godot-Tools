import * as fs from "node:fs";
import * as path from "node:path";

export type EngineMajor = "3" | "4";

const PROJECT_FILE = "project.godot";
const MAX_PARENT_DEPTH = 64;

/** Godot 4 writes `config_version=5`; Godot 3 projects use 4 or earlier. */
export function detectEngineMajor(projectText: string): EngineMajor {
	const feature = projectText.match(/config\/features=PackedStringArray\(([^)]*)\)/)?.[1];
	if (feature !== undefined && /"4\.[0-9]+"/.test(feature)) return "4";
	const configVersion = Number(projectText.match(/^config_version=([0-9]+)/m)?.[1] ?? "0");
	return configVersion >= 5 ? "4" : "3";
}

const sectionHeader = (line: string): string | undefined => line.match(/^\[([^\]]+)\]/)?.[1];

/** Removes `[autoload]` so a sandboxed render never boots project singletons. */
export function stripAutoloadSections(projectText: string): string {
	const lines = projectText.split(/\r?\n/);
	const start = lines.findIndex((line) => sectionHeader(line) === "autoload");
	if (start === -1) return lines.join("\n");
	const end = lines.findIndex((line, index) => index > start && sectionHeader(line) !== undefined);
	return [...lines.slice(0, start), ...lines.slice(end === -1 ? lines.length : end)].join("\n");
}

const walkToProjectRoot = (directory: string, depth: number): string | undefined => {
	if (fs.existsSync(path.join(directory, PROJECT_FILE))) return directory;
	const parent = path.dirname(directory);
	if (parent === directory || depth >= MAX_PARENT_DEPTH) return undefined;
	return walkToProjectRoot(parent, depth + 1);
};

/** Walks up from a file or directory until it finds a `project.godot`. */
export function findProjectRootForEntry(entry: string): string | undefined {
	const inside = fs.existsSync(entry) && fs.statSync(entry).isDirectory() ? entry : path.dirname(entry);
	return walkToProjectRoot(inside, 0);
}

/** Converts a file inside the project to its `res://` form; `undefined` when outside. */
export function toResourcePath(projectRoot: string, file: string): string | undefined {
	const relative = path.relative(projectRoot, file);
	if (relative.length === 0 || relative === ".." || relative.startsWith(`..${path.sep}`)) return undefined;
	if (path.isAbsolute(relative)) return undefined;
	return `res://${relative.split(path.sep).join("/")}`;
}
