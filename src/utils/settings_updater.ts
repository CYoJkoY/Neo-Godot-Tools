import * as vscode from "vscode";

const OLD_SETTINGS_CONVERSIONS = [
	["godot_tools.editor_path", "neoGodotTools.editorPath.godot3"],
	["godot_tools.editor_path", "neoGodotTools.editorPath.godot4"],
	["godot_tools.gdscript_lsp_server_protocol", "neoGodotTools.lsp.serverProtocol"],
	["godot_tools.gdscript_lsp_server_host", "neoGodotTools.lsp.serverHost"],
	["godot_tools.gdscript_lsp_server_port", "neoGodotTools.lsp.serverPort"],
	["godot_tools.reconnect_automatically", "neoGodotTools.lsp.autoReconnect.enabled"],
	["godot_tools.reconnect_cooldown", "neoGodotTools.lsp.autoReconnect.cooldown"],
	["godot_tools.reconnect_attempts", "neoGodotTools.lsp.autoReconnect.attempts"],
	["godot_tools.scenePreview.previewRelatedScenes", "neoGodotTools.scenePreview.previewRelatedScenes"],
];

const PREVIOUS_NAMESPACE_SETTINGS = [
	"documentation.pageScale",
	"documentation.displayMinimap",
	"editorPath.godot3",
	"editorPath.godot4",
	"editor.verbose",
	"editor.revealTerminal",
	"formatter.maxEmptyLines",
	"formatter.denseFunctionParameters",
	"formatter.spacesBeforeEndOfLineComment",
	"lsp.serverHost",
	"lsp.serverPort",
	"lsp.headless",
	"lsp.autoReconnect.enabled",
	"lsp.autoReconnect.cooldown",
	"lsp.autoReconnect.attempts",
	"scenePreview.previewRelatedScenes",
	"inlayHints.gdscript",
	"inlayHints.gdresource",
];

function updatePreviousNamespaceSettings(): boolean {
	let settings_changed = false;
	const previousConfiguration = vscode.workspace.getConfiguration("godotTools");
	const currentConfiguration = vscode.workspace.getConfiguration("neoGodotTools");
	for (const setting of PREVIOUS_NAMESPACE_SETTINGS) {
		const value = previousConfiguration.get(setting);
		if (value === undefined || currentConfiguration.get(setting) !== undefined) {
			continue;
		}
		currentConfiguration.update(setting, value, true);
		settings_changed = true;
	}
	return settings_changed;
}

export function updateOldStyleSettings() {
	const configuration = vscode.workspace.getConfiguration();
	let settings_changed = updatePreviousNamespaceSettings();
	for (const [old_style_key, new_style_key] of OLD_SETTINGS_CONVERSIONS) {
		const value = configuration.get(old_style_key);
		if (value === undefined || configuration.get(new_style_key) !== undefined) {
			continue;
		}
		configuration.update(new_style_key, value, true);
		settings_changed = true;
	}
	if (settings_changed) {
		vscode.window.showInformationMessage(
			`Neo Godot Tools settings have been updated to the current format.`,
			"Okay"
		);
	}
}

/**
 * Stores the current version of the extension to `context.globalState`,
 * which persists across restarts & updates.
 */
export function updateStoredVersion(context: vscode.ExtensionContext) {
	const syncedVersion: string = vscode.extensions.getExtension(context.extension.id)
		?.packageJSON.version;
	context.globalState.update("previousVersion", syncedVersion);
}

/**
 * Checks if settings should try and be converted from an older extension version.
 *
 * Returns `true` if the extension has no value saved for `previousVersion`
 * in `context.globalState`, meaning it was either just installed,
 * or updated from an older version. Otherwise, returns `false`.
 */
export function shouldUpdateSettings(context: vscode.ExtensionContext): boolean {
	const localVersion: string | undefined = context.globalState.get("previousVersion");
	return localVersion === undefined;
}

export function attemptSettingsUpdate(context: vscode.ExtensionContext) {
	updateOldStyleSettings();
	updateStoredVersion(context);
}
