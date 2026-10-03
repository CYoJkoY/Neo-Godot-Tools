import { inspect } from "node:util";
import { LogOutputChannel, window } from "vscode";
import { is_debug_mode } from ".";

export enum LOG_LEVEL {
	SILENT = 0,
	ERROR = 1,
	WARNING = 2,
	INFO = 3,
	DEBUG = 4,
	TRACE = 5,
}

const LOG_LEVEL_NAMES = [
	"SILENT", //
	"ERROR",
	"WARN ",
	"INFO ",
	"DEBUG",
	"TRACE",
];

const RESET = "\u001b[0m";

const LOG_COLORS = [
	RESET, // SILENT, normal
	"\u001b[1;31m", // ERROR, red
	"\u001b[1;33m", // WARNING, yellow
	"\u001b[1;36m", // INFO, cyan
	"\u001b[1;32m", // DEBUG, green
	"\u001b[1;35m", // TRACE, magenta
];

export interface LoggerOptions {
	level?: LOG_LEVEL;
	time?: boolean;
	output?: string;
}

export class Logger {
	private level: LOG_LEVEL = LOG_LEVEL.DEBUG;
	private show_tag = true;
	private show_time = false;
	private show_level = false;
	private output?: LogOutputChannel;

	constructor(
		private tag: string,
		{ level = LOG_LEVEL.DEBUG, time = false, output = "" }: LoggerOptions = {},
	) {
		this.level = level;
		this.show_time = time;
		if (output) {
			this.output = window.createOutputChannel(output, { log: true });
		}
	}

	private log(level: LOG_LEVEL, ...messages: readonly unknown[]) {
		if (is_debug_mode()) {
			let prefix = "";
			if (this.show_time) {
				prefix += `[${new Date().toISOString()}]`;
			}
			if (this.show_level) {
				prefix += `[${LOG_COLORS[level]}${LOG_LEVEL_NAMES[level]}${RESET}]`;
			}
			if (this.show_tag) {
				prefix += `[${LOG_COLORS[level]}${this.tag}${RESET}]`;
			}

			console.log(prefix, ...messages);
		}

		const output = this.output;
		if (!output) return;
		const [first = "", ...rest] = messages.map(to_text);
		switch (level) {
			case LOG_LEVEL.ERROR:
				output.error(first, ...rest);
				return;
			case LOG_LEVEL.WARNING:
				output.warn(first, ...rest);
				return;
			case LOG_LEVEL.INFO:
				output.info(first, ...rest);
				return;
			case LOG_LEVEL.DEBUG:
				output.debug(first, ...rest);
				return;
			case LOG_LEVEL.TRACE:
				output.trace(first, ...rest);
				return;
			default:
				return;
		}
	}

	error(...messages: readonly unknown[]): void {
		if (LOG_LEVEL.ERROR <= this.level) this.log(LOG_LEVEL.ERROR, ...messages);
	}
	warn(...messages: readonly unknown[]): void {
		if (LOG_LEVEL.WARNING <= this.level) this.log(LOG_LEVEL.WARNING, ...messages);
	}
	info(...messages: readonly unknown[]): void {
		if (LOG_LEVEL.INFO <= this.level) this.log(LOG_LEVEL.INFO, ...messages);
	}
	debug(...messages: readonly unknown[]): void {
		if (LOG_LEVEL.DEBUG <= this.level) this.log(LOG_LEVEL.DEBUG, ...messages);
	}
	trace(...messages: readonly unknown[]): void {
		if (LOG_LEVEL.TRACE <= this.level) this.log(LOG_LEVEL.TRACE, ...messages);
	}
}

/** Output channels are plain text, so structured values are inspected, not dropped. */
function to_text(value: unknown): string {
	if (typeof value === "string") return value;
	if (value instanceof Error) return value.stack ?? value.message;
	return inspect(value, { depth: 3, breakLength: 160 });
}

const loggers: Map<string, Logger> = new Map();

export function createLogger(tag: string, options?: LoggerOptions): Logger {
	const logger = new Logger(tag, options);
	loggers.set(tag, logger);
	return logger;
}
