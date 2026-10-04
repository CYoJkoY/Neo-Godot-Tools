/* 
Copied from https://github.com/craigwardman/subspawn
Original library copyright (c) 2022 Craig Wardman

I had to vendor this library to fix the API in a couple places.
*/

import {
	ChildProcess,
	ChildProcessWithoutNullStreams,
	SpawnOptions,
	SpawnOptionsWithoutStdio,
	execSync,
	spawn,
} from "node:child_process";
import { createLogger } from ".";

const log = createLogger("subspawn");

/** Live children per owner, so a session can be torn down without killing the editor. */
const children = new Map<string, ChildProcess[]>();

/** Windows and macOS have no process groups, so the platform tools are used instead. */
function force_kill(child: ChildProcess, pid: number): void {
	if (process.platform === "win32") {
		execSync(`taskkill /pid ${pid} /T /F`);
		return;
	}
	if (process.platform === "darwin") {
		execSync(`kill -9 ${pid}`);
		return;
	}
	try {
		process.kill(-pid, "SIGKILL");
	} catch {
		child.kill("SIGKILL");
	}
}

function kill_child(owner: string, child: ChildProcess): void {
	const pid = child.pid;
	if (pid === undefined) return;
	try {
		force_kill(child, pid);
	} catch {
		log.error(`couldn't kill task ${owner}`);
	}
}

export function killSubProcesses(owner: string): void {
	const owned = children.get(owner);
	children.delete(owner);
	owned?.map((child) => kill_child(owner, child));
}

process.on("exit", () => {
	[...children.keys()].map((owner) => killSubProcesses(owner));
});

process.on("SIGINT", () => process.exit());
process.on("SIGTERM", () => process.exit());
process.on("SIGQUIT", () => process.exit());

export function subProcess(
	owner: string,
	command: string,
	options: SpawnOptionsWithoutStdio = {},
	args: readonly string[] = [],
): ChildProcessWithoutNullStreams {
	const childProcess = spawn(command, args, options);
	const owned = children.get(owner) ?? [];
	owned.push(childProcess);
	children.set(owner, owned);
	return childProcess;
}

function quote_for_cmd(value: string): string {
	const trailing = value.match(/\\*$/)?.[0] ?? "";
	return `"${value.replace(/"/g, '""')}${trailing}"`;
}

function quote_for_ps(value: string): string {
	return `'${value.replace(/'/g, "''")}'`;
}

function spawn_via_powershell(command: string, args: readonly string[], cwd: string): ChildProcess {
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

function spawn_via_cmd_start(command: string, args: readonly string[], cwd: string): ChildProcess {
	const commandLine = [
		'/d /s /c start "" /d',
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

	if (process.platform === "win32") {
		const child = spawn_via_powershell(command, args, cwd);
		child.once("error", () => {
			log.warn("detachedProcess: Start-Process failed, falling back to cmd /c start");
			try {
				spawn_via_cmd_start(command, args, cwd).unref();
			} catch (error) {
				log.error(`detachedProcess: fallback launch failed: ${error}`);
			}
		});
		child.unref();
		return child;
	}

	const child = spawn(command, args, { ...options, detached: true, stdio: "ignore" });
	child.unref();
	return child;
}
