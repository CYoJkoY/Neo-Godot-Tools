import * as vscode from "vscode";

/** The three file-typed languages the resource-oriented providers serve. */
export const RESOURCE_SELECTOR: vscode.DocumentSelector = [
	{ language: "gdresource", scheme: "file" },
	{ language: "gdscene", scheme: "file" },
	{ language: "gdscript", scheme: "file" },
];

/** The languages that can hold a dropped scene node. */
export const SCRIPT_SELECTOR: vscode.DocumentSelector = [
	{ language: "csharp", scheme: "file" },
	{ language: "gdscript", scheme: "file" },
];
