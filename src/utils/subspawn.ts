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
	return `"${value.replace(/"/g, '""')}"`;
}

export function detachedProcess(
	command: string,
	args: readonly string[] = [],
	options: SpawnOptions = {},
): ChildProcess {
	if (process.platform === "win32") {
		// DETACHED_PROCESS does not break the parent/child link that `taskkill /T`
		// walks when the IDE shuts the extension host down. Launching through
		// `cmd /c start` re-parents the real process, so it outlives the IDE and
		// gets a chance to prompt for unsaved changes.
		const cwd = String(options.cwd ?? process.cwd());
		const commandLine = [
			"/d /s /c start \"\" /d",
			quote_for_cmd(cwd),
			quote_for_cmd(command),
			...args.map(quote_for_cmd),
		].join(" ");

		const child = spawn("cmd.exe", [commandLine], {
			...options,
			detached: true,
			stdio: "ignore",
			windowsHide: true,
			windowsVerbatimArguments: true,
		});
		child.unref();
		return child;
	}

	const child = spawn(command, args, {
		...options,
		detached: true,
		stdio: options.stdio ?? "ignore",
	});
	child.unref();
	return child;
}
