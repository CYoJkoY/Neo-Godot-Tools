import * as vscode from "vscode";
import { set_configuration } from ".";

export function prompt_for_reload() {
	const message = "Reload VSCode to apply settings";
	void vscode.window.showErrorMessage(message, "Reload").then((item) => {
		if (item === "Reload") void vscode.commands.executeCommand("workbench.action.restartExtensionHost");
	});
}

export function select_godot_executable(settingName: string) {
	void vscode.window
		.showOpenDialog({
			openLabel: "Select Godot executable",
			filters: process.platform === "win32" ? { "Godot Editor Binary": ["exe", "EXE"] } : undefined,
		})
		.then(async (uris) => {
			const [uri] = uris ?? [];
			if (!uri) return;
			set_configuration(settingName, uri.fsPath);
			prompt_for_reload();
		});
}

export function prompt_for_godot_executable(message: string, settingName: string) {
	void vscode.window.showErrorMessage(message, "Select Godot executable", "Open Settings", "Ignore").then((item) => {
		if (item === "Select Godot executable") select_godot_executable(settingName);
		if (item === "Open Settings") void vscode.commands.executeCommand("workbench.action.openSettings", settingName);
	});
}
