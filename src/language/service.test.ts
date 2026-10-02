import { strict as assert } from "node:assert";
import { describe, it } from "node:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import * as vscode from "vscode";
import { LanguageService } from "./service.js";
import { DefinitionFallback } from "../fallback/definition.js";
import { ReferencesFallback } from "../fallback/references.js";
import { RenameFallback } from "../fallback/rename.js";

interface MutableWorkspace {
	textDocuments: unknown[];
	workspaceFolders: Array<{ uri: vscode.Uri; name: string; index: number }>;
	findFiles: (include: string, exclude?: string) => Promise<vscode.Uri[]>;
	fs: { readFile: (uri: vscode.Uri) => Promise<Uint8Array> };
}

function sourceFor(index: number): string {
	return `class_name Script${index}\nextends Node\n\nvar value_${index} := ${index}\n\nfunc compute_${index}(amount_${index}: int) -> int:\n\tvar result_${index} := value_${index} + amount_${index}\n\treturn result_${index}\n`;
}

describe("workspace indexing responsiveness", () => {
	it("indexes a large project while yielding to the event loop", async () => {
		const workspace = vscode.workspace as unknown as MutableWorkspace;
		const previousDocuments = workspace.textDocuments;
		const previousFindFiles = workspace.findFiles;
		const previousFsReadFile = workspace.fs.readFile;

		const root = fs.mkdtempSync(path.join(os.tmpdir(), "ngdt-index-"));
		const count = 300;
		const uris: vscode.Uri[] = [];
		for (let index = 0; index < count; index++) {
			const file = path.join(root, `script_${index}.gd`);
			fs.writeFileSync(file, sourceFor(index));
			uris.push(vscode.Uri.file(file));
		}

		const service = new LanguageService(new DefinitionFallback(), new ReferencesFallback(), new RenameFallback());
		let ticks = 0;
		const timer = setInterval(() => ticks++, 1);
		try {
			workspace.textDocuments = [];
			workspace.findFiles = async () => uris;
			workspace.fs.readFile = async (uri: vscode.Uri) => fs.promises.readFile(uri.fsPath);
			// The constructor starts the scan; a second rebuild exercises the same
			// path deterministically and reports when it finished.
			await (service as unknown as { rebuildWorkspaceIndex(): Promise<void> }).rebuildWorkspaceIndex();
			clearInterval(timer);
			assert.equal(service.files.size, count);
			// A synchronous scan of 300 files cannot be interleaved at all; the
			// interval callback proves the loop kept running during the scan.
			assert.ok(ticks > 0, "the index scan blocked the event loop for its whole duration");
		} finally {
			clearInterval(timer);
			service.dispose();
			workspace.textDocuments = previousDocuments;
			workspace.findFiles = previousFindFiles;
			workspace.fs.readFile = previousFsReadFile;
			fs.rmSync(root, { recursive: true, force: true });
		}
	});

	it("stops scanning once disposed", async () => {
		const workspace = vscode.workspace as unknown as MutableWorkspace;
		const previousDocuments = workspace.textDocuments;
		const previousFindFiles = workspace.findFiles;
		const previousFsReadFile = workspace.fs.readFile;

		const root = fs.mkdtempSync(path.join(os.tmpdir(), "ngdt-dispose-"));
		const uris: vscode.Uri[] = [];
		for (let index = 0; index < 50; index++) {
			const file = path.join(root, `script_${index}.gd`);
			fs.writeFileSync(file, sourceFor(index));
			uris.push(vscode.Uri.file(file));
		}
		const service = new LanguageService(new DefinitionFallback(), new ReferencesFallback(), new RenameFallback());
		try {
			workspace.textDocuments = [];
			workspace.findFiles = async () => uris;
			workspace.fs.readFile = async (uri: vscode.Uri) => fs.promises.readFile(uri.fsPath);
			// Start a scan and dispose while it runs: it must stop instead of
			// finishing the project on a disposed service.
			const pending = (service as unknown as { rebuildWorkspaceIndex(): Promise<void> }).rebuildWorkspaceIndex();
			service.dispose();
			await pending;
			assert.equal(service.files.size, 0, "a disposed service must not keep indexing");
		} finally {
			workspace.textDocuments = previousDocuments;
			workspace.findFiles = previousFindFiles;
			workspace.fs.readFile = previousFsReadFile;
			fs.rmSync(root, { recursive: true, force: true });
		}
	});
});
