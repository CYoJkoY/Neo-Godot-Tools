import * as fs from "node:fs";
import * as path from "node:path";
import type { Scene, SceneNode } from "./types";
import { get_extension_uri } from "../utils";
import { yieldToEventLoop } from "../utils/scheduling";

const ICON_ROOT = get_extension_uri("resources", "godot_icons").fsPath;
const DEFAULT_NODE_ICON = "Node";
/** Skip pathological files while scanning scripts for custom classes. */
const MAX_SCRIPT_BYTES = 2 * 1024 * 1024;
const CLASS_INDEX_TTL_MS = 60_000;
/** Icon file existence never changes while the extension runs. */
const iconCache = new Map<string, boolean>();

function icon_exists(className: string): boolean {
	if (!className) return false;
	const cached = iconCache.get(className);
	if (cached !== undefined) return cached;
	const exists =
		fs.existsSync(path.join(ICON_ROOT, "light", `${className}.svg`)) ||
		fs.existsSync(path.join(ICON_ROOT, "dark", `${className}.svg`));
	iconCache.set(className, exists);
	return exists;
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

/**
 * `class_name` -> script path for the current project.
 *
 * The scan walks the project once, reads scripts asynchronously and yields
 * between directories: it runs while the user is browsing scenes, and doing it
 * synchronously froze the extension host on large projects.
 */
class ClassNameIndex {
	private readonly byName = new Map<string, string>();
	private projectDir = "";
	private builtAt = 0;
	private generation = 0;
	private building?: Promise<void>;

	async refresh(scenePath: string): Promise<void> {
		const dir = find_project_dir(scenePath);
		if (!dir) return;
		const fresh = dir === this.projectDir && this.byName.size > 0 && Date.now() - this.builtAt < CLASS_INDEX_TTL_MS;
		if (fresh) return;
		if (this.building) {
			await this.building;
			const stillFresh = dir === this.projectDir && this.byName.size > 0 && Date.now() - this.builtAt < CLASS_INDEX_TTL_MS;
			if (stillFresh) return;
		}
		const generation = ++this.generation;
		this.building = this.build(dir, generation);
		try {
			await this.building;
		} finally {
			this.building = undefined;
		}
	}

	/** Drops cached class names; called when a script file changes on disk. */
	invalidate(): void {
		this.builtAt = 0;
		this.generation++;
	}

	script_for(className: string): string | undefined {
		return this.byName.get(className);
	}

	private async build(dir: string, generation: number): Promise<void> {
		const found = new Map<string, string>();
		const skip = new Set([".git", ".godot", ".vscode", "bin", "build", "node_modules", "out"]);
		const queue: string[] = [dir];
		let scanned = 0;
		while (queue.length) {
			const current = queue.shift()!;
			let entries: fs.Dirent[];
			try {
				entries = await fs.promises.readdir(current, { withFileTypes: true });
			} catch {
				continue;
			}
			for (const entry of entries) {
				if (entry.name.startsWith(".") && entry.name !== ".godot") continue;
				if (skip.has(entry.name)) continue;
				const full = path.join(current, entry.name);
				if (entry.isDirectory()) {
					queue.push(full);
					continue;
				}
				const ext = path.extname(entry.name).toLowerCase();
				if (ext !== ".gd" && ext !== ".cs") continue;
				const className = await this.readClassName(full);
				if (className && !found.has(className)) found.set(className, full);
				scanned++;
				if (scanned % 64 === 0) await yieldToEventLoop();
			}
			await yieldToEventLoop();
		}
		// A script changed (or a newer scan started) while this one ran: keep the
		// previous index rather than publishing stale names.
		if (generation !== this.generation) return;
		this.projectDir = dir;
		this.builtAt = Date.now();
		this.byName.clear();
		for (const [className, file] of found) this.byName.set(className, file);
	}

	private async readClassName(file: string): Promise<string | undefined> {
		try {
			const stats = await fs.promises.stat(file);
			if (stats.size > MAX_SCRIPT_BYTES) return undefined;
			const source = await fs.promises.readFile(file, "utf8");
			return source.match(CLASS_NAME_RE)?.[1];
		} catch {
			return undefined;
		}
	}
}

const classIndex = new ClassNameIndex();
const baseClassCache = new Map<string, { base: string | undefined; mtime: number }>();

/** Invalidate cached custom-class metadata after a script file changed. */
export function invalidateNodeIconCaches(): void {
	classIndex.invalidate();
	baseClassCache.clear();
}

async function resolve_base_class(scriptPath: string, depth = 0): Promise<string | undefined> {
	if (depth > 8) return undefined;
	let stat: fs.Stats;
	try {
		stat = await fs.promises.stat(scriptPath);
	} catch {
		return undefined;
	}
	const cached = baseClassCache.get(scriptPath);
	if (cached && cached.mtime === stat.mtimeMs) return cached.base;

	let source: string;
	try {
		if (stat.size > MAX_SCRIPT_BYTES) return undefined;
		source = await fs.promises.readFile(scriptPath, "utf8");
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
			base = parentScript ? await resolve_base_class(parentScript, depth + 1) : DEFAULT_NODE_ICON;
		}
	} else {
		const projectDir = find_project_dir(scriptPath);
		const abs = projectDir ? res_to_abs(projectDir, target) : undefined;
		base = abs ? await resolve_base_class(abs, depth + 1) : DEFAULT_NODE_ICON;
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
	let processed = 0;

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
			// Scenes may serialize custom nodes with the global class name as their
			// type (`type="Hitbox"`) and no script resource; the class index maps
			// that name back to the script so the base engine icon can be used.
			const scriptPath = node_script_path(node, current, projectDir) ?? classIndex.script_for(node.className);
			const base = scriptPath ? await resolve_base_class(scriptPath) : undefined;
			node.setIconClass(base ?? DEFAULT_NODE_ICON);
			processed++;
			// Large scenes still yield so a scene switch cannot stall the host.
			if (processed % 128 === 0) await yieldToEventLoop();
		}
	}
}
