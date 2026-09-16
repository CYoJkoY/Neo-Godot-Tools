/* 
Copied from https://github.com/craigwardman/subspawn
Original library copyright (c) 2022 Craig Wardman

I had to vendor this library to fix the API in a couple places.
*/

import { ChildProcess, SpawnOptions, execSync, spawn, SpawnOptionsWithoutStdio } from "node:child_process";
import { createLogger } from ".";

const log = createLogger("subspawn");

interface DictionaryOfStringChildProcessArray {
	[key: string]: ChildProcess[];
}
const children: DictionaryOfStringChildProcessArray = {};

export function killSubProcesses(owner: string) {
	if (owner === "GodotEditor") {
		children[owner] = [];
		return;
	}

	if (!(owner in children)) {
		return;
	}

	for (const c of children[owner]) {
		try {
			if (c.pid) {
				if (process.platform === "win32") {
					execSync(`taskkill /pid ${c.pid} /T /F`);
				} else if (process.platform === "darwin") {
					execSync(`kill -9 ${c.pid}`);
				} else {
					try {
						process.kill(-c.pid, "SIGKILL");
					} catch {
						c.kill("SIGKILL");
					}
				}
			}
		} catch {
			log.error(`couldn't kill task ${owner}`);
		}
	}
	children[owner] = [];
}

process.on("exit", () => {
	for (const owner of Object.keys(children)) {
		killSubProcesses(owner);
	}
});

function gracefulExitHandler() {
	process.exit();
}

process.on("SIGINT", gracefulExitHandler);
process.on("SIGTERM", gracefulExitHandler);
process.on("SIGQUIT", gracefulExitHandler);

export function subProcess(
	owner: string,
	command: string,
	options: SpawnOptionsWithoutStdio = {},
	args: readonly string[] = [],
) {
	const childProcess = spawn(command, args, options);

	children[owner] = children[owner] || [];
	children[owner].push(childProcess);

	return childProcess;
}

function quote_for_cmd(value: string): string {
	const trailing = value.match(/\\*$/)?.[0] ?? "";
	return `"${value.replace(/"/g, '""')}${trailing}"`;
}

function quote_for_ps(value: string): string {
	return `'${value.replace(/'/g, "''")}'`;
}

function spawn_via_powershell(
	command: string,
	args: readonly string[],
	cwd: string,
): ChildProcess {
	const argList = args.length > 0 ? `@(${args.map(quote_for_ps).join(",")})` : "@()";
	const script =
		`Start-Process -FilePath ${quote_for_ps(command)} ` +
		`-ArgumentList ${argList} -WorkingDirectory ${quote_for_ps(cwd)}`;

	return spawn(
		"powershell.exe",
		["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-Command", script],
		{ windowsHide: true, windowsVerbatimArguments: true, stdio: "ignore" },
	);
}

function spawn_via_cmd_start(
	command: string,
	args: readonly string[],
	cwd: string,
): ChildProcess {
	const commandLine = [
		"/d /s /c start \"\" /d",
		quote_for_cmd(cwd),
		quote_for_cmd(command),
		...args.map(quote_for_cmd),
	].join(" ");

	return spawn("cmd.exe", [commandLine], {
		windowsHide: true,
		windowsVerbatimArguments: true,
		stdio: "ignore",
	});
}

export function detachedProcess(
	command: string,
	args: readonly string[] = [],
	options: SpawnOptions = {},
): ChildProcess {
	const cwd = String(options.cwd ?? process.cwd());

	// Windows
	if (process.platform === "win32") {
		const child = spawn_via_powershell(command, args, cwd);
		child.once("error", () => {
			log.warn("detachedProcess: Start-Process failed, falling back to cmd /c start");
			try {
				const fallback = spawn_via_cmd_start(command, args, cwd);
				fallback.unref();
			} catch (error) {
				log.error(`detachedProcess: fallback launch failed: ${error}`);
			}
		});
		child.unref();
		return child;
	}

	// MacOS
	if (process.platform === "darwin") {
		const child = spawn(command, args, { ...options, detached: true, stdio: "ignore" });
		child.unref();
		return child;
	}

	// Linux + Other
	const child = spawn(command, args, { ...options, detached: true, stdio: "ignore" });
	child.unref();
	return child;
}
