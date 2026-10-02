import * as fs from "node:fs";
import * as path from "node:path";
import * as vscode from "vscode";
import { yieldToEventLoop } from "../utils/scheduling";

const MAX_SCRIPT_BYTES = 2 * 1024 * 1024;
const INDEX_TTL_MS = 30_000;
const CLASS_NAME_RE = /^[ \t]*class_name[ \t]+([A-Za-z_][A-Za-z0-9_]*)/m;

/**
 * `class_name` -> script uri for the current workspace.
 *
 * The Resource Inspector needs this to attach a script to a `.tres` file
 * without a `script` property. Building it by walking the project with
 * synchronous `readFileSync` calls froze the extension host while a resource
 * was open, so the index is built asynchronously, cached and invalidated by the
 * `.gd` watcher.
 */
export class ScriptClassNameIndex {
	private entries = new Map<string, vscode.Uri>();
	private builtAt = 0;
	private generation = 0;
	private building: Promise<void> | undefined;

	/** Looks up a class name, building or refreshing the index when needed. */
	async find(className: string, contextUri?: vscode.Uri): Promise<vscode.Uri | undefined> {
		if (!className) return undefined;
		const open = this.findInOpenDocuments(className);
		if (open) return open;
		await this.ensure(contextUri);
		return this.entries.get(className);
	}

	/** Drops the index; called when a script file was created, changed or deleted. */
	invalidate(): void {
		this.builtAt = 0;
		this.generation++;
	}

	private findInOpenDocuments(className: string): vscode.Uri | undefined {
		const pattern = new RegExp(`^[ \\t]*class_name[ \\t]+${className}\\b`, "m");
		for (const document of vscode.workspace.textDocuments ?? []) {
			if (!document.uri.fsPath.toLowerCase().endsWith(".gd")) continue;
			if (pattern.test(document.getText())) return document.uri;
		}
		return undefined;
	}

	private async ensure(contextUri?: vscode.Uri): Promise<void> {
		if (this.entries.size > 0 && Date.now() - this.builtAt < INDEX_TTL_MS) return;
		if (this.building) {
			await this.building;
			return;
		}
		const generation = ++this.generation;
		this.building = this.build(generation, contextUri);
		try {
			await this.building;
		} finally {
			this.building = undefined;
		}
	}

	private async build(generation: number, contextUri?: vscode.Uri): Promise<void> {
		const found = new Map<string, vscode.Uri>();
		const files = await this.listScripts(contextUri);
		for (const uri of files) {
			if (generation !== this.generation) return;
			const className = await this.readClassName(uri);
			if (className && !found.has(className)) found.set(className, uri);
			await yieldToEventLoop();
		}
		if (generation !== this.generation) return;
		this.entries = found;
		this.builtAt = Date.now();
	}

	private async listScripts(contextUri?: vscode.Uri): Promise<vscode.Uri[]> {
		try {
			const found = await vscode.workspace.findFiles("**/*.gd", "**/{.git,.godot,node_modules,out}/**");
			if (found?.length) return found;
		} catch {
			/* fall through to the bounded directory walk */
		}
		const root = this.projectRoot(contextUri);
		return root ? this.walk(root) : [];
	}

	private projectRoot(contextUri?: vscode.Uri): string | undefined {
		const folder = contextUri ? vscode.workspace.getWorkspaceFolder?.(contextUri) : undefined;
		if (folder) return folder.uri.fsPath;
		return vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
	}

	/** Bounded, asynchronous directory walk used when `findFiles` is unavailable. */
	private async walk(root: string): Promise<vscode.Uri[]> {
		const result: vscode.Uri[] = [];
		const skip = new Set([".git", ".godot", ".vscode", "node_modules", "out", "build", "bin"]);
		const queue: string[] = [root];
		while (queue.length) {
			if (result.length > 20_000) break;
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
				if (entry.isDirectory()) queue.push(full);
				else if (entry.isFile() && entry.name.toLowerCase().endsWith(".gd")) result.push(vscode.Uri.file(full));
			}
			await yieldToEventLoop();
		}
		return result;
	}

	private async readClassName(uri: vscode.Uri): Promise<string | undefined> {
		const open = (vscode.workspace.textDocuments ?? []).find((document) => document.uri.toString() === uri.toString());
		if (open) return open.getText().match(CLASS_NAME_RE)?.[1];
		try {
			const stats = await fs.promises.stat(uri.fsPath);
			if (stats.size > MAX_SCRIPT_BYTES) return undefined;
			const source = await fs.promises.readFile(uri.fsPath, "utf8");
			return source.match(CLASS_NAME_RE)?.[1];
		} catch {
			return undefined;
		}
	}
}

export const scriptClassNameIndex = new ScriptClassNameIndex();
