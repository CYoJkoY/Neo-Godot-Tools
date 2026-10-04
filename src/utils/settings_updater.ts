import * as vscode from "vscode";

const LEGACY_SETTING_CONVERSIONS = [
	["godot_tools.editor_path", "neoGodotTools.editorPath.godot3"],
	["godot_tools.editor_path", "neoGodotTools.editorPath.godot4"],
	["godot_tools.gdscript_lsp_server_host", "neoGodotTools.lsp.serverHost"],
	["godot_tools.gdscript_lsp_server_port", "neoGodotTools.lsp.serverPort"],
	["godot_tools.reconnect_automatically", "neoGodotTools.lsp.autoReconnect.enabled"],
	["godot_tools.reconnect_cooldown", "neoGodotTools.lsp.autoReconnect.cooldown"],
	["godot_tools.reconnect_attempts", "neoGodotTools.lsp.autoReconnect.attempts"],
	["godot_tools.scenePreview.previewRelatedScenes", "neoGodotTools.scenePreview.previewRelatedScenes"],
] as const;

const LEGACY_NAMESPACE_SETTINGS = [
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
] as const;

function hasExplicitValue(configuration: vscode.WorkspaceConfiguration, setting: string): boolean {
	const inspection = configuration.inspect(setting);
	if (!inspection) return false;
	return (
		inspection.globalValue !== undefined ||
		inspection.workspaceValue !== undefined ||
		inspection.workspaceFolderValue !== undefined ||
		inspection.globalLanguageValue !== undefined ||
		inspection.workspaceLanguageValue !== undefined ||
		inspection.workspaceFolderLanguageValue !== undefined
	);
}

/** Copies an inherited value into `targetKey` unless it is already set explicitly there. */
function migrate_value(configuration: vscode.WorkspaceConfiguration, sourceKey: string, targetKey: string): boolean {
	const value = configuration.get(sourceKey);
	if (value === undefined || hasExplicitValue(configuration, targetKey)) return false;
	configuration.update(targetKey, value, true);
	return true;
}

function updatePreviousNamespaceSettings(): boolean {
	const configuration = vscode.workspace.getConfiguration("neoGodotTools");
	return LEGACY_NAMESPACE_SETTINGS.map((setting) => migrate_value(configuration, setting, setting)).some(
		(changed) => changed,
	);
}

export function updateOldStyleSettings(): void {
	const configuration = vscode.workspace.getConfiguration();
	const namespaceChanged = updatePreviousNamespaceSettings();
	const legacyChanged = LEGACY_SETTING_CONVERSIONS.map(([oldStyleKey, newStyleKey]) =>
		migrate_value(configuration, oldStyleKey, newStyleKey),
	).some((changed) => changed);
	if (!namespaceChanged && !legacyChanged) return;
	vscode.window.showInformationMessage("Neo Godot Tools settings have been updated to the current format.", "Okay");
}

/**
 * Stores the current version of the extension to `context.globalState`,
 * which persists across restarts & updates.
 */
export function updateStoredVersion(context: vscode.ExtensionContext) {
	const syncedVersion: string = vscode.extensions.getExtension(context.extension.id)?.packageJSON.version;
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
