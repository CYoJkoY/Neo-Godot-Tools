/**
 * Helpers for handing a Godot editor a clean process environment.
 *
 * The VS Code extension host is itself an Electron process started with
 * `ELECTRON_RUN_AS_NODE=1`. Godot forwards its environment to the external
 * editor it launches, so an Electron-based editor would start in Node mode and
 * reject flags such as `--goto`.
 */

const NODE_MODE_FLAG = "ELECTRON_RUN_AS_NODE";

/** A copy of `environment` without the flag that selects Electron's Node mode. */
export function editor_environment(environment: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
	const sanitized: NodeJS.ProcessEnv = { ...environment };
	delete sanitized[NODE_MODE_FLAG];
	return sanitized;
}

/**
 * Quotes one argument for a Windows command line.
 *
 * Follows the parsing rules of `CommandLineToArgvW`, which Node and the
 * Windows runtime both use: backslashes are literal unless they precede a
 * quote, and quotes inside a value are escaped with a backslash.
 */
export function quote_windows_argument(argument: string): string {
	if (argument.length === 0) return '""';
	if (!/[\s"]/.test(argument)) return argument;
	const escaped = argument.replace(/(\\*)"/g, '$1$1\\"').replace(/(\\+)$/, "$1$1");
	return `"${escaped}"`;
}

/** A single-quoted PowerShell literal; embedded quotes are doubled. */
function quote_powershell_literal(value: string): string {
	return `'${value.replace(/'/g, "''")}'`;
}

/**
 * The `Start-Process` command used to detach Godot on Windows.
 *
 * `-ArgumentList` receives one command line rather than an array so PowerShell
 * cannot split a project path that contains spaces into separate arguments.
 */
export function build_start_process_script(command: string, args: readonly string[], cwd: string): string {
	const argument_line = args.map(quote_windows_argument).join(" ");
	const argument_option =
		argument_line.length > 0 ? ` -ArgumentList ${quote_powershell_literal(argument_line)}` : "";
	return (
		`Start-Process -FilePath ${quote_powershell_literal(command)}` +
		`${argument_option} -WorkingDirectory ${quote_powershell_literal(cwd)}`
	);
}

/** The `cmd /c start` fallback command line, quoted with the same rules. */
export function build_cmd_start_command(command: string, args: readonly string[], cwd: string): string {
	return [
		"/d",
		"/s",
		"/c",
		"start",
		'""',
		"/d",
		quote_windows_argument(cwd),
		quote_windows_argument(command),
		...args.map(quote_windows_argument),
	].join(" ");
}
