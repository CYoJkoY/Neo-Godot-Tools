import * as vscode from "vscode";

const EXTENSION_PREFIX = "neoGodotTools";
const COMMAND_PREFIX = "neoGodotTools";

/** A command handler; `never` parameters accept any concrete signature. */
export type CommandHandler = (...args: never[]) => unknown;

/** Reads `neoGodotTools.<name>`; `defaultValue` is used when the setting is unset. */
export function get_configuration<T>(name: string, defaultValue: T): T;
export function get_configuration<T = string>(name: string): T | null;
export function get_configuration<T = string>(name: string, defaultValue?: T): T | null {
	const configValue = vscode.workspace.getConfiguration(EXTENSION_PREFIX).get<T | null>(name, null);
	return defaultValue !== undefined && configValue === null ? defaultValue : configValue;
}

export function set_configuration(name: string, value: unknown) {
	return vscode.workspace.getConfiguration(EXTENSION_PREFIX).update(name, value);
}

const CONTEXT_PREFIX = `${EXTENSION_PREFIX}.context.`;

export function set_context(name: string, value: unknown) {
	return vscode.commands.executeCommand("setContext", CONTEXT_PREFIX + name, value);
}

export function register_command(command: string, callback: CommandHandler, thisArg?: unknown): vscode.Disposable {
	return vscode.commands.registerCommand(`${COMMAND_PREFIX}.${command}`, callback, thisArg);
}

export function get_extension_uri(...paths: string[]) {
	const extension = vscode.extensions.getExtension("CYoJkoY.neo-godot-tools");
	if (!extension) {
		throw new Error("Extension 'CYoJkoY.neo-godot-tools' not found");
	}
	return vscode.Uri.joinPath(extension.extensionUri, ...paths);
}
