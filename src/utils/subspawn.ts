/* 
Copied from https://github.com/craigwardman/subspawn
Original library copyright (c) 2022 Craig Wardman

I had to vendor this library to fix the API in a couple places.
*/

import { ChildProcess, execSync, spawn, SpawnOptionsWithoutStdio } from "node:child_process";
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
					process.kill(-c.pid);
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

function cleanQuotes(value: string): string {
	return value.replace(/^["']|["']$/g, "");
}

function quoteWindowsStartArg(value: string): string {
	const cleaned = cleanQuotes(value);
	return `"${cleaned.replace(/"/g, '""')}"`;
}

function prepareSpawn(owner: string, command: string, options: SpawnOptionsWithoutStdio, args: readonly string[]) {
	if (process.platform !== "win32" || owner !== "GodotEditor") {
		return { command, options, args };
	}

	const cleanCommand = cleanQuotes(command);
	const cleanArgs = args.map(cleanQuotes);
	const commandLine = [cleanCommand, ...cleanArgs].map(quoteWindowsStartArg).join(" ");

	return {
		command: "cmd.exe",
		args: ["/d", "/c", "start", "", commandLine],
		options: { ...options, detached: true, windowsHide: false },
	};
}

export function subProcess(owner: string, command: string, options: SpawnOptionsWithoutStdio = {}, args: readonly string[] = []) {
	const prepared = prepareSpawn(owner, command, options, args);
	const childProcess = spawn(prepared.command, prepared.args, prepared.options);

	children[owner] = children[owner] || [];
	children[owner].push(childProcess);

	return childProcess;
}
