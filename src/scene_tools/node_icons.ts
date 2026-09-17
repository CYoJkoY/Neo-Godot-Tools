import * as fs from "node:fs";
import * as path from "node:path";
import type { Scene, SceneNode } from "./types";
import { get_extension_uri } from "../utils";

const ICON_ROOT = get_extension_uri("resources", "godot_icons").fsPath;
const DEFAULT_NODE_ICON = "Node";

function icon_exists(className: string): boolean {
	if (!className) return false;
	return (
		fs.existsSync(path.join(ICON_ROOT, "light", `${className}.svg`)) ||
		fs.existsSync(path.join(ICON_ROOT, "dark", `${className}.svg`))
	);
}

function res_to_abs(projectDir: string, resPath: string): string | undefined {
	if (!resPath.startsWith("res://")) return undefined;
	return path.join(projectDir, resPath.slice("res://".length));
}

function find_project_dir(fromFile: string): string | undefined {
	let dir = path.dirname(fromFile);
	while (true) {
		if (fs.existsSync(path.join(dir, "project.godot"))) return dir;
		const parent = path.dirname(dir);
		if (parent === dir) return undefined;
		dir = parent;
	}
}

const CLASS_NAME_RE = /^[ \t]*class_name[ \t]+([A-Za-z_][A-Za-z0-9_]*)/m;
const GD_EXTENDS_RE =
	/^[ \t]*extends[ \t]+(?:"([^"]+)"|'([^']+)'|([A-Za-z_][A-Za-z0-9_]*(?:\.[A-Za-z_][A-Za-z0-9_]*)*))/m;
const CS_EXTENDS_RE = /^[ \t]*(?:public[ \t]+)?(?:partial[ \t]+)?class[ \t]+[A-Za-z_][A-Za-z0-9_]*[ \t]*:[ \t]*([A-Za-z_][A-Za-z0-9_]*)/m;

function script_extends(source: string): string | undefined {
	const gd = source.match(GD_EXTENDS_RE);
	if (gd) return gd[1] ?? gd[2] ?? gd[3];
	const cs = source.match(CS_EXTENDS_RE);
	return cs?.[1];
}

class ClassNameIndex {
	private readonly byName = new Map<string, string>();
	private projectDir = "";

	async refresh(scenePath: string): Promise<void> {
		const dir = find_project_dir(scenePath);
		if (!dir) return;
		if (dir === this.projectDir && this.byName.size > 0) return;
		this.projectDir = dir;
		this.byName.clear();
		await this.walk(dir);
	}

	private async walk(dir: string): Promise<void> {
		const skip = new Set([".git", ".godot", ".vscode", "bin", "build", "node_modules"]);
		const entries = await fs.promises.readdir(dir, { withFileTypes: true });
		for (const entry of entries) {
			if (entry.name.startsWith(".") && entry.name !== ".godot") continue;
			if (skip.has(entry.name)) continue;
			const full = path.join(dir, entry.name);
			if (entry.isDirectory()) {
				await this.walk(full);
				continue;
			}
			const ext = path.extname(entry.name).toLowerCase();
			if (ext === ".gd" || ext === ".cs") this.index_file(full);
		}
	}

	private index_file(file: string): void {
		let source: string;
		try {
			source = fs.readFileSync(file, "utf8");
		} catch {
			return;
		}
		const match = source.match(CLASS_NAME_RE);
		if (match?.[1]) this.byName.set(match[1], file);
	}

	script_for(className: string): string | undefined {
		return this.byName.get(className);
	}
}

const classIndex = new ClassNameIndex();
const baseClassCache = new Map<string, { base: string | undefined; mtime: number }>();

function resolve_base_class(scriptPath: string, depth = 0): string | undefined {
	if (depth > 8) return undefined;
	let stat: fs.Stats;
	try {
		stat = fs.statSync(scriptPath);
	} catch {
		return undefined;
	}
	const cached = baseClassCache.get(scriptPath);
	if (cached && cached.mtime === stat.mtimeMs) return cached.base;

	let source: string;
	try {
		source = fs.readFileSync(scriptPath, "utf8");
	} catch {
		return undefined;
	}

	const direct = source.match(CLASS_NAME_RE)?.[1];
	let base: string | undefined;
	const target = script_extends(source);
	if (!target) {
		base = DEFAULT_NODE_ICON;
	} else if (/^[A-Za-z_]/.test(target)) {
		if (icon_exists(target)) {
			base = target;
		} else {
			const parentScript = direct && direct !== target ? classIndex.script_for(target) : undefined;
			if (parentScript) {
				base = resolve_base_class(parentScript, depth + 1);
			} else {
				base = DEFAULT_NODE_ICON;
			}
		}
	} else {
		const projectDir = find_project_dir(scriptPath);
		const abs = projectDir ? res_to_abs(projectDir, target) : undefined;
		base = abs ? resolve_base_class(abs, depth + 1) : DEFAULT_NODE_ICON;
	}

	baseClassCache.set(scriptPath, { base, mtime: stat.mtimeMs });
	return base;
}

function node_script_path(node: SceneNode, scene: Scene, projectDir: string | undefined): string | undefined {
	const ids = [node.scriptId, node.customTypeScriptId].filter(Boolean);
	for (const id of ids) {
		const resource = scene.externalResources.get(id);
		if (resource?.path?.startsWith("res://") && projectDir) {
			return res_to_abs(projectDir, resource.path);
		}
	}
	const uids = [node.customTypeScriptUid].filter(Boolean);
	if (uids.length > 0) {
		for (const resource of scene.externalResources.values()) {
			if (resource.uid && uids.includes(resource.uid) && projectDir) {
				return res_to_abs(projectDir, resource.path);
			}
		}
	}
	const subId = node.customTypeScriptSubResourceId;
	if (subId) {
		const sub = scene.subResources.get(subId);
		if (sub?.body) {
			const inner = script_extends(sub.body.replace(/\\n/g, "\n"));
			if (inner && /^[A-Za-z_]/.test(inner) && icon_exists(inner)) return undefined;
			if (inner && /^[A-Za-z_]/.test(inner)) {
				const parentScript = classIndex.script_for(inner);
				if (parentScript) return parentScript;
			}
		}
	}

	for (const resource of scene.externalResources.values()) {
		if (resource.type === "Script" && resource.path?.startsWith("res://") && projectDir) {
			return res_to_abs(projectDir, resource.path);
		}
	}
	return undefined;
}

export async function apply_custom_class_icons(scene: Scene): Promise<void> {
	await classIndex.refresh(scene.path);
	const projectDir = find_project_dir(scene.path);
	const visited = new Set<Scene>();
	const queue: Scene[] = [scene];

	while (queue.length > 0) {
		const current = queue.shift()!;
		if (visited.has(current)) continue;
		visited.add(current);

		for (const node of current.nodes.values()) {
			if (node.instanceScene) queue.push(node.instanceScene);
			if (icon_exists(node.className)) {
				node.setIconClass(node.className);
				continue;
			}
			const scriptPath = node_script_path(node, current, projectDir);
			const base = scriptPath ? resolve_base_class(scriptPath) : undefined;
			node.setIconClass(base ?? DEFAULT_NODE_ICON);
		}
	}
}
