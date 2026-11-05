import * as fs from "node:fs";
import * as path from "node:path";
import { get_extension_uri } from "../utils";
import { createLruCache } from "../utils/lru_cache";

const ICON_ROOT = get_extension_uri("resources", "godot_icons").fsPath;
const iconCache = createLruCache<string, boolean>({ capacity: 2048 });

export function icon_exists(className: string): boolean {
	if (!className) return false;
	const cached = iconCache.get(className);
	if (cached !== undefined) return cached;
	const exists =
		fs.existsSync(path.join(ICON_ROOT, "light", `${className}.svg`)) ||
		fs.existsSync(path.join(ICON_ROOT, "dark", `${className}.svg`));
	iconCache.set(className, exists);
	return exists;
}

export function icon_path(className: string, theme: "light" | "dark"): string {
	return path.join(ICON_ROOT, theme, `${className}.svg`);
}
