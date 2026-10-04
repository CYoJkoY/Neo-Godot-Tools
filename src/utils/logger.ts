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

const RESET = "\u001b[0m";
const ACCENT = "\u001b[1;36m";

export interface LoggerOptions {
	/** Messages above this level are dropped. Defaults to `DEBUG`. */
	level?: LOG_LEVEL;
	/** Name of the VS Code output channel to mirror into. */
	output?: string;
}

export interface Logger {
	error(...messages: readonly unknown[]): void;
	warn(...messages: readonly unknown[]): void;
	info(...messages: readonly unknown[]): void;
	debug(...messages: readonly unknown[]): void;
	trace(...messages: readonly unknown[]): void;
}

/** Output channels are plain text, so structured values are inspected, not dropped. */
function to_text(value: unknown): string {
	if (typeof value === "string") return value;
	if (value instanceof Error) return value.stack ?? value.message;
	return inspect(value, { depth: 3, breakLength: 160 });
}

const write_to_channel = (channel: LogOutputChannel, level: LOG_LEVEL, messages: readonly unknown[]): void => {
	const [first = "", ...rest] = messages.map(to_text);
	switch (level) {
		case LOG_LEVEL.ERROR:
			channel.error(first, ...rest);
			return;
		case LOG_LEVEL.WARNING:
			channel.warn(first, ...rest);
			return;
		case LOG_LEVEL.INFO:
			channel.info(first, ...rest);
			return;
		case LOG_LEVEL.DEBUG:
			channel.debug(first, ...rest);
			return;
		case LOG_LEVEL.TRACE:
			channel.trace(first, ...rest);
			return;
		default:
			return;
	}
};

const loggers: Map<string, Logger> = new Map();

export function createLogger(tag: string, options: LoggerOptions = {}): Logger {
	const level = options.level ?? LOG_LEVEL.DEBUG;
	const channel = options.output ? window.createOutputChannel(options.output, { log: true }) : undefined;
	const prefix = `[${ACCENT}${tag}${RESET}]`;

	const emit =
		(messageLevel: LOG_LEVEL) =>
		(...messages: readonly unknown[]): void => {
			if (messageLevel > level) return;
			if (is_debug_mode()) console.log(prefix, ...messages);
			if (channel) write_to_channel(channel, messageLevel, messages);
		};

	const logger: Logger = {
		error: emit(LOG_LEVEL.ERROR),
		warn: emit(LOG_LEVEL.WARNING),
		info: emit(LOG_LEVEL.INFO),
		debug: emit(LOG_LEVEL.DEBUG),
		trace: emit(LOG_LEVEL.TRACE),
	};
	loggers.set(tag, logger);
	return logger;
}
