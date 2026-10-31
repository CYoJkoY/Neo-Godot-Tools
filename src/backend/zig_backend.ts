/**
 * Client for the Zig analysis sidecar.
 *
 * One adapter owns at most one child process. Requests are multiplexed over the
 * Content-Length framed JSON-RPC stream, and every failure path settles each
 * pending callback exactly once.
 */

import { type ChildProcessWithoutNullStreams, spawn } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";
import type { Writable } from "node:stream";

import type {
	GDScriptDeclaration,
	GDScriptDiagnostic,
	GDScriptEnumMember,
	GDScriptNodeKind,
	GDScriptParameter,
	GDScriptParseResult,
	GDScriptScript,
	SourcePosition,
	SourceRange,
} from "../analyzer/ast.js";
import type { GDScriptToken, GDScriptTokenKind } from "../analyzer/lexer.js";

const PROTOCOL_VERSION = 1;
const MAX_RESTART_ATTEMPTS = 3;
const RESTART_DELAY_MS = 250;
const HEALTH_TIMEOUT_MS = 5000;
const SHUTDOWN_GRACE_MS = 1000;
const STDERR_TAIL_LIMIT = 8192;
const MAX_RESPONSE_HEADER_BYTES = 8 * 1024;
const MAX_RESPONSE_BODY_BYTES = 256 * 1024 * 1024;
const MAX_REQUEST_BODY_BYTES = 16 * 1024 * 1024;
const BACKEND_EXECUTABLE_NAME = "neo-godot-backend";
const EXECUTABLE_ENVIRONMENT_KEY = "NEO_GODOT_TOOLS_ZIG_BACKEND";
const REQUIRE_BACKEND_ENVIRONMENT_KEY = "NEO_GODOT_TOOLS_REQUIRE_ZIG_BACKEND";
const LINE_FEED = 0x0a;
const CARRIAGE_RETURN = 0x0d;

export interface ZigBackendOptions {
	readonly onDiagnostic?: (message: string) => void;
}

export interface ZigBackendTokenOptions {
	readonly signal?: AbortSignal;
}

export interface ZigBackendSymbolInput {
	readonly name: string;
	readonly start: number;
	readonly end: number;
}

export interface ZigBackendFileSymbols {
	readonly uri: string;
	readonly symbols: readonly ZigBackendSymbolInput[];
}

export interface ZigBackendIngestedFile {
	readonly uri: string;
	readonly ids: Uint32Array;
}

export interface ZigBackendIngestResult {
	readonly revision: number;
	readonly files: readonly ZigBackendIngestedFile[];
}

export interface ZigBackendDigest {
	readonly revision: number;
	readonly files: number;
	readonly symbols: number;
}

export interface ZigBackendCapabilities {
	readonly lex: boolean;
	readonly parse: boolean;
	readonly symbols: boolean;
}

export interface ZigBackend {
	lex(source: string, options?: ZigBackendTokenOptions): Promise<GDScriptToken[]>;
	parse(source: string, options?: ZigBackendTokenOptions): Promise<GDScriptParseResult>;
	readonly capabilities: ZigBackendCapabilities;
	ingestSymbols(
		revision: number,
		files: readonly ZigBackendFileSymbols[],
		options?: ZigBackendTokenOptions,
	): Promise<ZigBackendIngestResult>;
	removeSymbols(revision: number, uri: string, options?: ZigBackendTokenOptions): Promise<number>;
	querySymbols(revision: number, query: string, options?: ZigBackendTokenOptions): Promise<Uint32Array>;
	digestSymbols(options?: ZigBackendTokenOptions): Promise<ZigBackendDigest>;
	clearSymbols(revision: number, options?: ZigBackendTokenOptions): Promise<number>;
	shutdown(): Promise<void>;
}

export type ZigBackendExecutableResolution =
	| { readonly kind: "resolved"; readonly executable: string }
	| { readonly kind: "missing"; readonly message: string; readonly candidates: readonly string[] }
	| { readonly kind: "invalid-environment"; readonly message: string };

interface PendingRequest {
	readonly resolve: (value: unknown) => void;
	readonly reject: (error: Error) => void;
	readonly cleanup: () => void;
}

interface RestartGate {
	readonly release: () => void;
	handle: ReturnType<typeof setTimeout> | undefined;
}

interface ResponseFrameState {
	headerBytes: number;
	contentLength: number | undefined;
	awaitingBody: boolean;
}

interface ProcessListeners {
	readonly onStdout: (chunk: Buffer) => void;
	readonly onStderr: (chunk: Buffer) => void;
	readonly onExit: (code: number | null, signal: NodeJS.Signals | null) => void;
	readonly onError: (error: Error) => void;
	readonly onStdinError: (error: Error) => void;
	readonly onStdoutError: (error: Error) => void;
	readonly onStderrError: (error: Error) => void;
}

interface BackendProcess {
	readonly child: ChildProcessWithoutNullStreams;
	finalized: boolean;
	stdoutChunks: Buffer[];
	stdoutBytes: number;
	stderrTail: Buffer;
	frame: ResponseFrameState;
	listeners: ProcessListeners | undefined;
}

interface Lifecycle {
	disposed: boolean;
	child: BackendProcess | undefined;
	startup: Promise<void> | undefined;
	readonly pending: Map<number, PendingRequest>;
	nextRequestId: number;
	startAttempts: number;
	restartsUsed: number;
	restartGate: RestartGate | undefined;
	shutdownPromise: Promise<void> | undefined;
	shutdownResolve: (() => void) | undefined;
	shutdownTimer: ReturnType<typeof setTimeout> | undefined;
	capabilities: ZigBackendCapabilities;
	capabilitiesKnown: boolean;
}

type SpawnResult =
	| { readonly kind: "spawned"; readonly child: ChildProcessWithoutNullStreams }
	| { readonly kind: "failed"; readonly error: Error };

type StartReservation =
	| { readonly kind: "reserved"; readonly restart: boolean }
	| { readonly kind: "exhausted"; readonly error: Error };

type JsonParseResult = { readonly kind: "parsed"; readonly value: unknown } | { readonly kind: "invalid" };

const isRecord = (value: unknown): value is Readonly<Record<string, unknown>> =>
	typeof value === "object" && value !== null && !Array.isArray(value);

const asError = (value: unknown): Error => (value instanceof Error ? value : new Error(String(value)));

const hasOwn = (record: Readonly<Record<string, unknown>>, key: string): boolean =>
	Object.prototype.hasOwnProperty.call(record, key);

const isDefined = <T>(value: T | undefined): value is T => value !== undefined;

const pathApiFor = (platform: NodeJS.Platform): path.PlatformPath => (platform === "win32" ? path.win32 : path.posix);

const executableNameFor = (platform: NodeJS.Platform): string =>
	platform === "win32" ? `${BACKEND_EXECUTABLE_NAME}.exe` : BACKEND_EXECUTABLE_NAME;

const withExecutableExtension = (candidate: string, platform: NodeJS.Platform): string => {
	if (platform !== "win32") return candidate;
	return candidate.toLowerCase().endsWith(".exe") ? candidate : `${candidate}.exe`;
};

const missingExecutableMessage = (candidates: readonly string[]): string =>
	`Zig backend executable was not found. Build it with "npm run build:backend" and checked: ${candidates.join(", ")}.`;

/**
 * Resolves the sidecar from an explicit environment and file lookup so tests can
 * exercise the security rules without depending on the host installation.
 */
export const resolveZigBackendExecutable = (
	baseDirectory: string,
	environment: Readonly<Record<string, string | undefined>>,
	platform: NodeJS.Platform,
	isFile: (candidate: string) => boolean,
): ZigBackendExecutableResolution => {
	const pathApi = pathApiFor(platform);
	const override = environment[EXECUTABLE_ENVIRONMENT_KEY];
	if (override !== undefined) {
		if (override.length === 0 || !pathApi.isAbsolute(override)) {
			return {
				kind: "invalid-environment",
				message: `${EXECUTABLE_ENVIRONMENT_KEY} must be an absolute path; received ${JSON.stringify(override)}.`,
			};
		}
		const executable = withExecutableExtension(override, platform);
		if (!isFile(executable)) {
			return { kind: "missing", message: missingExecutableMessage([executable]), candidates: [executable] };
		}
		return { kind: "resolved", executable };
	}

	const executableName = executableNameFor(platform);
	const candidates = Array.from(
		new Set([
			pathApi.resolve(baseDirectory, "../../../backend/zig-out/bin", executableName),
			pathApi.resolve(baseDirectory, "../../backend/zig-out/bin", executableName),
			pathApi.resolve(baseDirectory, "../backend/zig-out/bin", executableName),
		]),
	);
	const executable = candidates.find(isFile);
	if (executable === undefined) {
		return { kind: "missing", message: missingExecutableMessage(candidates), candidates };
	}
	return { kind: "resolved", executable };
};

const isRegularFile = (candidate: string): boolean => {
	try {
		return fs.statSync(candidate).isFile();
	} catch {
		return false;
	}
};

const resolveInstalledExecutable = (): ZigBackendExecutableResolution =>
	resolveZigBackendExecutable(__dirname, process.env, process.platform, isRegularFile);

const reportDiagnostic = (options: ZigBackendOptions, message: string): void => {
	const handler = options.onDiagnostic;
	if (handler === undefined) return;
	try {
		handler(message);
	} catch (error: unknown) {
		console.error("Zig backend diagnostic handler failed.", error);
	}
};

const createShutdownError = (): Error => new Error("Zig backend is shut down.");

const createAbortError = (): Error => {
	const error = new Error("Zig backend request was cancelled.");
	error.name = "AbortError";
	return error;
};

const createFrameState = (): ResponseFrameState => ({
	headerBytes: 0,
	contentLength: undefined,
	awaitingBody: false,
});

const createProcessState = (child: ChildProcessWithoutNullStreams): BackendProcess => ({
	child,
	finalized: false,
	stdoutChunks: [],
	stdoutBytes: 0,
	stderrTail: Buffer.alloc(0),
	frame: createFrameState(),
	listeners: undefined,
});

const appendStdout = (state: BackendProcess, chunk: Buffer): void => {
	if (chunk.length === 0) return;
	state.stdoutChunks.push(chunk);
	state.stdoutBytes += chunk.length;
};

const resetStdout = (state: BackendProcess): void => {
	state.stdoutChunks = [];
	state.stdoutBytes = 0;
};

interface StdoutPrefix {
	readonly parts: readonly Buffer[];
	readonly rest: Buffer[];
}

/**
 * Splits the leading `count` bytes off the retained chunks without copying
 * anything past that prefix.
 */
const collectStdoutPrefix = (chunks: readonly Buffer[], count: number): StdoutPrefix => {
	const split = chunks.reduce<{ parts: Buffer[]; rest: Buffer[]; remaining: number }>(
		(accumulator, chunk) => {
			if (accumulator.remaining === 0) {
				accumulator.rest.push(chunk);
				return accumulator;
			}
			if (chunk.length <= accumulator.remaining) {
				accumulator.parts.push(chunk);
				accumulator.remaining -= chunk.length;
				return accumulator;
			}
			accumulator.parts.push(chunk.subarray(0, accumulator.remaining));
			accumulator.rest.push(chunk.subarray(accumulator.remaining));
			accumulator.remaining = 0;
			return accumulator;
		},
		{ parts: [], rest: [], remaining: count },
	);
	return { parts: split.parts, rest: split.rest };
};

/** Removes and returns exactly `count` leading bytes, or undefined when they have not arrived yet. */
const takeStdout = (state: BackendProcess, count: number): Buffer | undefined => {
	if (count === 0) return Buffer.alloc(0);
	if (state.stdoutBytes < count) return undefined;
	const { parts, rest } = collectStdoutPrefix(state.stdoutChunks, count);
	const prefix = parts.length === 1 ? parts[0] : Buffer.concat(parts, count);
	state.stdoutChunks = rest;
	state.stdoutBytes -= count;
	return prefix;
};

interface LineFeedScan {
	readonly found: boolean;
	readonly offset: number;
}

/** Finds the first LF among retained chunks, stopping once the header size limit is passed. */
const findLineFeed = (chunks: readonly Buffer[], headerBytes: number): LineFeedScan =>
	chunks.reduce<LineFeedScan>(
		(scan, chunk) => {
			const withinLimit = scan.offset + headerBytes <= MAX_RESPONSE_HEADER_BYTES;
			if (scan.found || !withinLimit) return scan;
			const local = chunk.indexOf(LINE_FEED);
			if (local !== -1) return { found: true, offset: scan.offset + local };
			return { found: false, offset: scan.offset + chunk.length };
		},
		{ found: false, offset: 0 },
	);

const appendStderrTail = (tail: Buffer, chunk: Buffer): Buffer => {
	if (chunk.length >= STDERR_TAIL_LIMIT) return Buffer.from(chunk.subarray(chunk.length - STDERR_TAIL_LIMIT));
	const combined = Buffer.concat([tail, chunk]);
	if (combined.length <= STDERR_TAIL_LIMIT) return combined;
	return Buffer.from(combined.subarray(combined.length - STDERR_TAIL_LIMIT));
};

const reserveStartAttempt = (lifecycle: Lifecycle): StartReservation => {
	const restart = lifecycle.startAttempts > 0;
	if (restart && lifecycle.restartsUsed >= MAX_RESTART_ATTEMPTS) {
		return {
			kind: "exhausted",
			error: new Error(`Zig backend restarted ${MAX_RESTART_ATTEMPTS} times and is disabled for this session.`),
		};
	}
	lifecycle.startAttempts += 1;
	if (restart) lifecycle.restartsUsed += 1;
	return { kind: "reserved", restart };
};

const waitForRestartWindow = (lifecycle: Lifecycle): Promise<void> => {
	const gate = { release: (): void => {}, handle: undefined as ReturnType<typeof setTimeout> | undefined };
	const wait = new Promise<void>((resolve) => {
		const release = (): void => {
			if (gate.handle !== undefined) clearTimeout(gate.handle);
			gate.handle = undefined;
			if (lifecycle.restartGate === gate) lifecycle.restartGate = undefined;
			resolve();
		};
		gate.release = release;
		lifecycle.restartGate = gate;
		gate.handle = setTimeout(release, RESTART_DELAY_MS);
	});
	return wait;
};

const cancelRestartWindow = (lifecycle: Lifecycle): void => {
	const gate = lifecycle.restartGate;
	if (gate === undefined) return;
	lifecycle.restartGate = undefined;
	gate.release();
};

const attemptSpawn = (executable: string): SpawnResult => {
	try {
		const child = spawn(executable, [], { stdio: ["pipe", "pipe", "pipe"], windowsHide: true });
		return { kind: "spawned", child };
	} catch (error: unknown) {
		return { kind: "failed", error: asError(error) };
	}
};

const writeFramedBody = (stream: Writable, body: Buffer, onWriteError: (error: Error) => void): void => {
	if (stream.destroyed) {
		onWriteError(new Error("Zig backend stdin is closed."));
		return;
	}
	const header = Buffer.from(`Content-Length: ${body.length}\r\n\r\n`, "ascii");
	const frame = Buffer.concat([header, body]);
	try {
		stream.write(frame, (error: Error | null | undefined) => {
			if (error !== null && error !== undefined) onWriteError(error);
		});
	} catch (error: unknown) {
		onWriteError(asError(error));
	}
};

const takePending = (lifecycle: Lifecycle, id: number): PendingRequest | undefined => {
	const entry = lifecycle.pending.get(id);
	if (entry === undefined) return undefined;
	lifecycle.pending.delete(id);
	return entry;
};

const settlePending = (lifecycle: Lifecycle, id: number, value: unknown): void => {
	const entry = takePending(lifecycle, id);
	if (entry === undefined) return;
	entry.cleanup();
	entry.resolve(value);
};

const failPending = (lifecycle: Lifecycle, id: number, error: Error): void => {
	const entry = takePending(lifecycle, id);
	if (entry === undefined) return;
	entry.cleanup();
	entry.reject(error);
};

const rejectAllPending = (lifecycle: Lifecycle, error: Error): void => {
	const entries = Array.from(lifecycle.pending.values());
	lifecycle.pending.clear();
	entries.reduce<void>((accumulator, entry) => {
		entry.cleanup();
		entry.reject(error);
		return accumulator;
	}, undefined);
};

const allocateRequestId = (lifecycle: Lifecycle): number => {
	const id = lifecycle.nextRequestId;
	lifecycle.nextRequestId += 1;
	return id;
};

const writeCancelNotification = (lifecycle: Lifecycle, state: BackendProcess, id: number): void => {
	if (state.finalized || lifecycle.child !== state) return;
	const body = Buffer.from(JSON.stringify({ jsonrpc: "2.0", method: "$/cancelRequest", params: { id } }), "utf8");
	writeFramedBody(state.child.stdin, body, () => {
		/* The local promise is already settled; process failure is reported by the exit handler. */
	});
};

const sendRequestOnProcess = (
	lifecycle: Lifecycle,
	state: BackendProcess,
	method: string,
	params: Readonly<Record<string, unknown>> | undefined,
	timeoutMs: number | undefined,
	signal: AbortSignal | undefined,
): Promise<unknown> => {
	if (state.finalized || lifecycle.child !== state) {
		return Promise.reject(new Error("Zig backend process is not available."));
	}
	if (signal?.aborted === true) return Promise.reject(createAbortError());

	const id = allocateRequestId(lifecycle);
	const request: Record<string, unknown> = { jsonrpc: "2.0", id, method };
	if (params !== undefined) request["params"] = params;
	const serialized = JSON.stringify(request);
	if (serialized === undefined) return Promise.reject(new Error("Unable to serialize the Zig backend request."));
	const body = Buffer.from(serialized, "utf8");
	if (body.length > MAX_REQUEST_BODY_BYTES) {
		return Promise.reject(
			new Error(
				`Zig backend request body is ${body.length} bytes and exceeds the ${MAX_REQUEST_BODY_BYTES} byte limit.`,
			),
		);
	}

	return new Promise<unknown>((resolve, reject) => {
		const timer = { handle: undefined as ReturnType<typeof setTimeout> | undefined };
		const abort = { listener: undefined as (() => void) | undefined };
		const cleanup = (): void => {
			if (timer.handle !== undefined) clearTimeout(timer.handle);
			timer.handle = undefined;
			if (abort.listener !== undefined && signal !== undefined) {
				signal.removeEventListener("abort", abort.listener);
				abort.listener = undefined;
			}
		};
		const entry: PendingRequest = { resolve, reject, cleanup };
		lifecycle.pending.set(id, entry);

		if (signal !== undefined) {
			const listener = (): void => {
				const active = takePending(lifecycle, id);
				if (active === undefined) return;
				active.cleanup();
				active.reject(createAbortError());
				writeCancelNotification(lifecycle, state, id);
			};
			abort.listener = listener;
			signal.addEventListener("abort", listener, { once: true });
			if (signal.aborted) {
				listener();
				return;
			}
		}

		if (timeoutMs !== undefined) {
			timer.handle = setTimeout(() => {
				failPending(lifecycle, id, new Error(`Zig backend request timed out after ${timeoutMs} ms.`));
			}, timeoutMs);
		}

		writeFramedBody(state.child.stdin, body, (error) => failPending(lifecycle, id, error));
	});
};

const isTokenKind = (value: unknown): value is GDScriptTokenKind => {
	switch (value) {
		case "identifier":
		case "number":
		case "string":
		case "operator":
		case "punctuation":
		case "newline":
		case "eof":
			return true;
		default:
			return false;
	}
};

const readOffset = (record: Readonly<Record<string, unknown>>, key: string): number | undefined => {
	const value = record[key];
	return typeof value === "number" && Number.isSafeInteger(value) && value >= 0 ? value : undefined;
};

const parseToken = (value: unknown): GDScriptToken | undefined => {
	if (!isRecord(value)) return undefined;
	const kind = value["kind"];
	const encoded = value["valueBase64"];
	const start = readOffset(value, "start");
	const end = readOffset(value, "end");
	const line = readOffset(value, "line");
	const character = readOffset(value, "character");
	const indent = readOffset(value, "indent");
	if (!isTokenKind(kind)) return undefined;
	if (typeof encoded !== "string") return undefined;
	if (start === undefined || end === undefined || line === undefined) return undefined;
	if (character === undefined || indent === undefined) return undefined;
	return {
		kind,
		value: Buffer.from(encoded, "base64").toString("utf16le"),
		start,
		end,
		line,
		character,
		indent,
	};
};

const parseLexResult = (value: unknown): GDScriptToken[] | undefined => {
	if (!isRecord(value)) return undefined;
	const encodedTokens = value["tokens"];
	if (!Array.isArray(encodedTokens)) return undefined;
	const tokens = encodedTokens.map((entry: unknown) => parseToken(entry)).filter(isDefined);
	if (tokens.length !== encodedTokens.length) return undefined;
	return tokens;
};

const isNodeKind = (value: unknown): value is GDScriptNodeKind => {
	switch (value) {
		case "script":
		case "class":
		case "class_name":
		case "extends":
		case "signal":
		case "enum":
		case "constant":
		case "variable":
		case "function":
			return true;
		default:
			return false;
	}
};

const decodePosition = (value: unknown): SourcePosition | undefined => {
	if (!isRecord(value)) return undefined;
	const offset = readOffset(value, "offset");
	const line = readOffset(value, "line");
	const character = readOffset(value, "character");
	if (offset === undefined || line === undefined || character === undefined) return undefined;
	return { offset, line, character };
};

const decodeRange = (value: unknown): SourceRange | undefined => {
	if (!isRecord(value)) return undefined;
	const start = decodePosition(value["start"]);
	const end = decodePosition(value["end"]);
	if (start === undefined || end === undefined) return undefined;
	return { start, end };
};

const decodeBase64String = (encoded: unknown): string | undefined => {
	if (typeof encoded !== "string") return undefined;
	return Buffer.from(encoded, "base64").toString("utf16le");
};

const decodeStringTable = (value: unknown): string[] | undefined => {
	if (!Array.isArray(value)) return undefined;
	const strings = value.map((entry: unknown) => decodeBase64String(entry));
	if (strings.includes(undefined)) return undefined;
	return strings.filter(isDefined);
};

interface StringTableReader {
	read(index: unknown): string | undefined;
	readOrNull(index: unknown): string | null | undefined;
}

const createStringTableReader = (strings: readonly string[]): StringTableReader => {
	const read = (index: unknown): string | undefined => {
		if (typeof index !== "number" || !Number.isSafeInteger(index) || index < 0) return undefined;
		return strings[index];
	};
	return {
		read,
		readOrNull: (index: unknown): string | null | undefined => (index === null ? null : read(index)),
	};
};

const readRequiredString = (reader: StringTableReader, value: unknown): string | undefined => reader.read(value);

const readOptionalString = (reader: StringTableReader, value: unknown): string | null | undefined =>
	reader.readOrNull(value);

const decodeAll = <T>(value: unknown, decode: (entry: unknown) => T | undefined): T[] | undefined => {
	if (!Array.isArray(value)) return undefined;
	const decoded = value.map((entry: unknown) => decode(entry));
	return decoded.includes(undefined) ? undefined : decoded.filter(isDefined);
};

const decodeParameters = (value: unknown, reader: StringTableReader): GDScriptParameter[] | undefined =>
	decodeAll(value, (entry: unknown) => {
		if (!isRecord(entry)) return undefined;
		const name = readRequiredString(reader, entry["name"]);
		const type = readOptionalString(reader, entry["type"]);
		const defaultValue = readOptionalString(reader, entry["defaultValue"]);
		const parameterRange = decodeRange(entry["range"]);
		if (name === undefined) return undefined;
		if (type === undefined || defaultValue === undefined) return undefined;
		if (parameterRange === undefined) return undefined;
		return { name, type: type ?? undefined, defaultValue: defaultValue ?? undefined, range: parameterRange };
	});

const decodeEnumMembers = (value: unknown, reader: StringTableReader): GDScriptEnumMember[] | undefined =>
	decodeAll(value, (entry: unknown) => {
		if (!isRecord(entry)) return undefined;
		const name = readRequiredString(reader, entry["name"]);
		const memberValue = readOptionalString(reader, entry["value"]);
		const memberRange = decodeRange(entry["range"]);
		if (name === undefined || memberRange === undefined) return undefined;
		if (memberValue === undefined) return undefined;
		return { name, value: memberValue ?? undefined, range: memberRange };
	});

const decodeDeclaration = (value: unknown, reader: StringTableReader): GDScriptDeclaration | undefined => {
	if (!isRecord(value)) return undefined;
	const kind = value["kind"];
	if (!isNodeKind(kind) || kind === "script") return undefined;
	const declarationRange = decodeRange(value["range"]);
	if (declarationRange === undefined) return undefined;
	const nameOffsetValue = value["nameOffset"];
	if (kind === "extends") {
		if (nameOffsetValue !== undefined) return undefined;
		const name = readRequiredString(reader, value["name"]);
		if (name === undefined) return undefined;
		return { kind, name, range: declarationRange };
	}
	if (kind === "enum") {
		const name = reader.readOrNull(value["name"]);
		const members = decodeEnumMembers(value["members"], reader);
		if (name === undefined || members === undefined) return undefined;
		const enumNameOffset = nameOffsetValue === null ? undefined : readOffset(value, "nameOffset");
		if (enumNameOffset === undefined && nameOffsetValue !== null) return undefined;
		return { kind, name: name ?? undefined, nameOffset: enumNameOffset, members, range: declarationRange };
	}
	if (nameOffsetValue === null) return undefined;
	const nameOffset = readOffset(value, "nameOffset");
	if (nameOffset === undefined) return undefined;

	switch (kind) {
		case "class_name": {
			const name = readRequiredString(reader, value["name"]);
			if (name === undefined) return undefined;
			return { kind, name, nameOffset, range: declarationRange };
		}
		case "signal": {
			const name = readRequiredString(reader, value["name"]);
			const parameters = decodeParameters(value["parameters"], reader);
			if (name === undefined || parameters === undefined) return undefined;
			return { kind, name, nameOffset, parameters, range: declarationRange };
		}
		case "constant":
		case "variable": {
			const name = readRequiredString(reader, value["name"]);
			const type = reader.readOrNull(value["type"]);
			const declarationValue = reader.readOrNull(value["value"]);
			if (name === undefined) return undefined;
			if (type === undefined || declarationValue === undefined) return undefined;
			return {
				kind,
				name,
				nameOffset,
				type: type ?? undefined,
				value: declarationValue ?? undefined,
				range: declarationRange,
			};
		}
		case "function": {
			const name = readRequiredString(reader, value["name"]);
			const parameters = decodeParameters(value["parameters"], reader);
			const returnType = reader.readOrNull(value["returnType"]);
			const encodedStatic = value["static"];
			const indent = readOffset(value, "indent");
			const bodyRangeValue = value["bodyRange"];
			if (name === undefined || parameters === undefined) return undefined;
			if (returnType === undefined || indent === undefined) return undefined;
			if (typeof encodedStatic !== "boolean") return undefined;
			const bodyRange = bodyRangeValue === null ? undefined : decodeRange(bodyRangeValue);
			if (bodyRangeValue !== null && bodyRange === undefined) return undefined;
			return {
				kind,
				name,
				nameOffset,
				parameters,
				returnType: returnType ?? undefined,
				static: encodedStatic,
				indent,
				bodyRange,
				range: declarationRange,
			};
		}
		case "class": {
			const name = readRequiredString(reader, value["name"]);
			const extendsName = reader.readOrNull(value["extendsName"]);
			const declarations = decodeDeclarations(value["declarations"], reader);
			if (name === undefined || declarations === undefined) return undefined;
			if (extendsName === undefined) return undefined;
			return { kind, name, nameOffset, extendsName: extendsName ?? undefined, declarations, range: declarationRange };
		}
		default:
			return undefined;
	}
};

const decodeDeclarations = (value: unknown, reader: StringTableReader): GDScriptDeclaration[] | undefined =>
	decodeAll(value, (entry: unknown) => decodeDeclaration(entry, reader));

const decodeDiagnostics = (value: unknown, reader: StringTableReader): GDScriptDiagnostic[] | undefined =>
	decodeAll(value, (entry: unknown) => {
		if (!isRecord(entry)) return undefined;
		const message = readRequiredString(reader, entry["message"]);
		const diagnosticRange = decodeRange(entry["range"]);
		const severity = entry["severity"];
		if (message === undefined || diagnosticRange === undefined) return undefined;
		if (severity !== "error" && severity !== "warning") return undefined;
		return { message, range: diagnosticRange, severity };
	});

const parseParseResult = (value: unknown): GDScriptParseResult | undefined => {
	if (!isRecord(value)) return undefined;
	const strings = decodeStringTable(value["strings"]);
	if (strings === undefined) return undefined;
	const reader = createStringTableReader(strings);
	const encodedAst = value["ast"];
	if (!isRecord(encodedAst)) return undefined;
	if (encodedAst["kind"] !== "script") return undefined;
	const scriptRange = decodeRange(encodedAst["range"]);
	const declarations = decodeDeclarations(encodedAst["declarations"], reader);
	const diagnostics = decodeDiagnostics(value["diagnostics"], reader);
	if (scriptRange === undefined || declarations === undefined) return undefined;
	if (diagnostics === undefined) return undefined;
	const ast: GDScriptScript = { kind: "script", range: scriptRange, declarations };
	return { ast, diagnostics };
};

const requestParse = (
	lifecycle: Lifecycle,
	state: BackendProcess,
	source: string,
	signal: AbortSignal | undefined,
): Promise<GDScriptParseResult> => {
	const params = {
		sourceBase64: Buffer.from(source, "utf16le").toString("base64"),
		encoding: "utf16le",
	};
	return sendRequestOnProcess(lifecycle, state, "parse", params, undefined, signal).then((result) => {
		const parsed = parseParseResult(result);
		if (parsed !== undefined) return parsed;
		return Promise.reject(new Error("Zig backend returned a malformed parse result."));
	});
};

const requestLex = (
	lifecycle: Lifecycle,
	state: BackendProcess,
	source: string,
	signal: AbortSignal | undefined,
): Promise<GDScriptToken[]> => {
	const params = {
		sourceBase64: Buffer.from(source, "utf16le").toString("base64"),
		encoding: "utf16le",
	};
	return sendRequestOnProcess(lifecycle, state, "lex", params, undefined, signal).then((result) => {
		const tokens = parseLexResult(result);
		if (tokens !== undefined) return tokens;
		return Promise.reject(new Error("Zig backend returned malformed lex tokens."));
	});
};

const decodeIds = (encoded: unknown): Uint32Array | undefined => {
	if (typeof encoded !== "string") return undefined;
	if (encoded.length === 0) return new Uint32Array(0);
	const bytes = Buffer.from(encoded, "base64");
	if (bytes.length % 4 !== 0) return undefined;
	return Uint32Array.from({ length: bytes.length / 4 }, (_value, index) => bytes.readUInt32LE(index * 4));
};

const parseIngestedFile = (expected: string, entry: unknown): ZigBackendIngestedFile | undefined => {
	if (!isRecord(entry)) return undefined;
	if (entry["uri"] !== expected) return undefined;
	const ids = decodeIds(entry["idsBase64"]);
	if (ids === undefined) return undefined;
	return { uri: expected, ids };
};

const parseIngestResult = (
	expectedUris: readonly string[],
	value: unknown,
): ZigBackendIngestResult | undefined => {
	if (!isRecord(value)) return undefined;
	const revision = readOffset(value, "revision");
	if (revision === undefined) return undefined;
	const encodedFiles = value["files"];
	if (!Array.isArray(encodedFiles)) return undefined;
	if (encodedFiles.length !== expectedUris.length) return undefined;
	const files = encodedFiles.map((entry, index) => parseIngestedFile(expectedUris[index], entry));
	if (files.includes(undefined)) return undefined;
	return { revision, files: files.filter(isDefined) };
};

const parseRevisionResult = (value: unknown): number | undefined => {
	if (!isRecord(value)) return undefined;
	return readOffset(value, "revision");
};

const parseDigestResult = (value: unknown): ZigBackendDigest | undefined => {
	if (!isRecord(value)) return undefined;
	const revision = readOffset(value, "revision");
	const files = readOffset(value, "files");
	const symbols = readOffset(value, "symbols");
	if (revision === undefined || files === undefined || symbols === undefined) return undefined;
	return { revision, files, symbols };
};

const requestSymbols = <T>(
	lifecycle: Lifecycle,
	state: BackendProcess,
	method: string,
	params: Readonly<Record<string, unknown>> | undefined,
	signal: AbortSignal | undefined,
	malformed: string,
	parse: (value: unknown) => T | undefined,
): Promise<T> =>
	sendRequestOnProcess(lifecycle, state, `symbols/${method}`, params, undefined, signal).then((result) => {
		const parsed = parse(result);
		if (parsed !== undefined) return parsed;
		return Promise.reject(new Error(malformed));
	});

const isCompatibleHealth = (value: unknown): boolean => {
	if (!isRecord(value)) return false;
	if (value["protocolVersion"] !== PROTOCOL_VERSION) return false;
	const capabilities = value["capabilities"];
	if (!Array.isArray(capabilities)) return false;
	return capabilities.some((entry: unknown) => entry === "lex");
};

/** Reads the declared capability list; older binaries simply omit `parse`. */
export const readZigBackendCapabilities = (health: unknown): ZigBackendCapabilities | undefined => {
	if (!isRecord(health)) return undefined;
	const declared = health["capabilities"];
	if (!Array.isArray(declared)) return undefined;
	const supports = (name: string): boolean => declared.some((entry: unknown) => entry === name);
	return { lex: supports("lex"), parse: supports("parse"), symbols: supports("symbols") };
};

const recordCapabilities = (lifecycle: Lifecycle, health: unknown): void => {
	const capabilities = readZigBackendCapabilities(health);
	if (capabilities === undefined) return;
	lifecycle.capabilities = capabilities;
	lifecycle.capabilitiesKnown = true;
};

const completeHandshake = (lifecycle: Lifecycle, state: BackendProcess): Promise<Error | undefined> =>
	sendRequestOnProcess(lifecycle, state, "health", undefined, HEALTH_TIMEOUT_MS, undefined).then(
		(health) => {
			if (isCompatibleHealth(health)) {
				recordCapabilities(lifecycle, health);
				return undefined;
			}
			return new Error(`Zig backend failed the protocol ${PROTOCOL_VERSION} health check with lex capability.`);
		},
		(error: unknown) => asError(error),
	);

const parseJson = (text: string): JsonParseResult => {
	try {
		const value: unknown = JSON.parse(text);
		return { kind: "parsed", value };
	} catch {
		return { kind: "invalid" };
	}
};

const parseResponseError = (value: unknown): Error => {
	if (!isRecord(value)) return new Error("Zig backend returned an invalid error response.");
	const code = typeof value["code"] === "number" ? value["code"] : undefined;
	const message = typeof value["message"] === "string" ? value["message"] : undefined;
	const data = value["data"];
	const detail = isRecord(data) && typeof data["detail"] === "string" ? data["detail"] : undefined;
	const heading = code === undefined ? "Zig backend error" : `Zig backend error ${code}`;
	const withMessage = message === undefined ? heading : `${heading}: ${message}`;
	const withDetail = detail === undefined ? withMessage : `${withMessage} (${detail})`;
	return new Error(withDetail);
};

const numericResponseId = (value: unknown): number | undefined =>
	typeof value === "number" && Number.isSafeInteger(value) ? value : undefined;

const handleResponseBody = (lifecycle: Lifecycle, body: Buffer): string | undefined => {
	const parsed = parseJson(body.toString("utf8"));
	if (parsed.kind === "invalid") return "Zig backend response body is not valid JSON.";
	if (!isRecord(parsed.value)) return "Zig backend response is not a JSON object.";
	const id = numericResponseId(parsed.value["id"]);
	if (id === undefined) return undefined;
	if (!lifecycle.pending.has(id)) return undefined;
	const errorValue = parsed.value["error"];
	if (errorValue !== undefined) {
		failPending(lifecycle, id, parseResponseError(errorValue));
		return undefined;
	}
	if (!hasOwn(parsed.value, "result")) {
		failPending(lifecycle, id, new Error("Zig backend response has neither result nor error."));
		return undefined;
	}
	settlePending(lifecycle, id, parsed.value["result"]);
	return undefined;
};

const parseContentLength = (line: Buffer, colon: number): number | string => {
	const raw = line
		.subarray(colon + 1)
		.toString("ascii")
		.trim();
	if (!/^[0-9]+$/.test(raw)) return "Zig backend response has an invalid Content-Length header.";
	const length = Number(raw);
	if (!Number.isSafeInteger(length)) return "Zig backend response Content-Length is not a safe integer.";
	return length;
};

const drainResponseFrames = (lifecycle: Lifecycle, state: BackendProcess): string | undefined => {
	if (state.finalized) return undefined;
	if (state.frame.awaitingBody) {
		const length = state.frame.contentLength;
		if (length === undefined) return "Zig backend response is missing Content-Length.";
		const body = takeStdout(state, length);
		if (body === undefined) return undefined;
		state.frame = createFrameState();
		const bodyError = handleResponseBody(lifecycle, body);
		if (bodyError !== undefined) return bodyError;
		return drainResponseFrames(lifecycle, state);
	}

	const scan = findLineFeed(state.stdoutChunks, state.frame.headerBytes);
	if (!scan.found) {
		if (state.frame.headerBytes + state.stdoutBytes > MAX_RESPONSE_HEADER_BYTES) {
			return "Zig backend response headers exceed the size limit.";
		}
		return undefined;
	}

	const lineBreak = scan.offset;
	const headerBytes = state.frame.headerBytes + lineBreak + 1;
	if (headerBytes > MAX_RESPONSE_HEADER_BYTES) return "Zig backend response headers exceed the size limit.";
	state.frame.headerBytes = headerBytes;
	const rawHeaderLine = takeStdout(state, lineBreak + 1);
	if (rawHeaderLine === undefined) return "Zig backend response header bytes were not retained.";
	const rawLine = rawHeaderLine.subarray(0, lineBreak);
	const line =
		rawLine.length > 0 && rawLine[rawLine.length - 1] === CARRIAGE_RETURN ? rawLine.subarray(0, -1) : rawLine;

	if (line.length === 0) {
		const length = state.frame.contentLength;
		if (length === undefined) return "Zig backend response is missing Content-Length.";
		if (length > MAX_RESPONSE_BODY_BYTES) return "Zig backend response body exceeds the size limit.";
		state.frame.awaitingBody = true;
		return drainResponseFrames(lifecycle, state);
	}

	const colon = line.indexOf(0x3a);
	if (colon <= 0) return "Zig backend response has a malformed header.";
	const name = line.subarray(0, colon).toString("ascii").trim().toLowerCase();
	if (name === "content-length") {
		const parsed = parseContentLength(line, colon);
		if (typeof parsed === "string") return parsed;
		if (state.frame.contentLength !== undefined && state.frame.contentLength !== parsed) {
			return "Zig backend response has conflicting Content-Length headers.";
		}
		state.frame.contentLength = parsed;
	}
	return drainResponseFrames(lifecycle, state);
};

const detachProcess = (state: BackendProcess): void => {
	const listeners = state.listeners;
	if (listeners !== undefined) {
		const { child } = state;
		child.removeListener("exit", listeners.onExit);
		child.removeListener("error", listeners.onError);
		child.stdout.removeListener("data", listeners.onStdout);
		child.stdout.removeListener("error", listeners.onStdoutError);
		child.stderr.removeListener("data", listeners.onStderr);
		child.stderr.removeListener("error", listeners.onStderrError);
		child.stdin.removeListener("error", listeners.onStdinError);
		state.listeners = undefined;
	}
	state.child.stdin.destroy();
	state.child.stdout.destroy();
	state.child.stderr.destroy();
};

const completeShutdown = (lifecycle: Lifecycle): void => {
	const timer = lifecycle.shutdownTimer;
	lifecycle.shutdownTimer = undefined;
	if (timer !== undefined) clearTimeout(timer);
	const resolve = lifecycle.shutdownResolve;
	lifecycle.shutdownResolve = undefined;
	if (resolve !== undefined) resolve();
};

const finalizeProcess = (lifecycle: Lifecycle, state: BackendProcess, error: Error): void => {
	if (state.finalized) return;
	state.finalized = true;
	detachProcess(state);
	const wasActive = lifecycle.child === state;
	if (wasActive) lifecycle.child = undefined;
	resetStdout(state);
	state.stderrTail = Buffer.alloc(0);
	state.frame = createFrameState();
	// Capabilities describe the process that answered the handshake; a restart
	// reports a fresh set once its own health check completes.
	if (wasActive) {
		lifecycle.capabilities = { lex: false, parse: false, symbols: false };
		lifecycle.capabilitiesKnown = false;
	}
	rejectAllPending(lifecycle, error);
	completeShutdown(lifecycle);
};

const terminateProcess = (
	lifecycle: Lifecycle,
	options: ZigBackendOptions,
	state: BackendProcess,
	reason: string,
	diagnose: boolean,
): void => {
	if (diagnose) reportDiagnostic(options, reason);
	finalizeProcess(lifecycle, state, new Error(reason));
	if (state.child.exitCode !== null || state.child.signalCode !== null) return;
	try {
		const killed = state.child.kill();
		if (!killed && diagnose) reportDiagnostic(options, "Zig backend process could not be terminated.");
	} catch (error: unknown) {
		if (diagnose) reportDiagnostic(options, `Zig backend termination failed: ${asError(error).message}`);
	}
};

const attachProcess = (lifecycle: Lifecycle, options: ZigBackendOptions, state: BackendProcess): void => {
	const onStdout = (chunk: Buffer): void => {
		if (state.finalized) return;
		appendStdout(state, chunk);
		const error = drainResponseFrames(lifecycle, state);
		if (error === undefined) return;
		terminateProcess(lifecycle, options, state, error, true);
	};
	const onStderr = (chunk: Buffer): void => {
		if (state.finalized) return;
		state.stderrTail = appendStderrTail(state.stderrTail, chunk);
		const message = chunk.toString("utf8").trim();
		if (message.length > 0) reportDiagnostic(options, message);
	};
	const onExit = (code: number | null, signal: NodeJS.Signals | null): void => {
		if (state.finalized) return;
		if (lifecycle.disposed) {
			finalizeProcess(lifecycle, state, createShutdownError());
			return;
		}
		const tail = state.stderrTail.toString("utf8").trim();
		const heading = `Zig backend exited unexpectedly (code ${String(code)}, signal ${String(signal)}).`;
		const reason = tail.length === 0 ? heading : `${heading} ${tail}`;
		reportDiagnostic(options, reason);
		finalizeProcess(lifecycle, state, new Error(reason));
	};
	const onError = (error: Error): void => {
		if (state.finalized) return;
		terminateProcess(lifecycle, options, state, `Zig backend process error: ${error.message}`, true);
	};
	const onStdinError = (error: Error): void => {
		if (state.finalized) return;
		terminateProcess(lifecycle, options, state, `Zig backend stdin error: ${error.message}`, true);
	};
	const onStdoutError = (error: Error): void => {
		if (state.finalized) return;
		terminateProcess(lifecycle, options, state, `Zig backend stdout error: ${error.message}`, true);
	};
	const onStderrError = (error: Error): void => {
		if (state.finalized) return;
		terminateProcess(lifecycle, options, state, `Zig backend stderr error: ${error.message}`, true);
	};
	const listeners: ProcessListeners = {
		onStdout,
		onStderr,
		onExit,
		onError,
		onStdinError,
		onStdoutError,
		onStderrError,
	};
	state.listeners = listeners;
	state.child.stdout.on("data", onStdout);
	state.child.stderr.on("data", onStderr);
	state.child.stdin.on("error", onStdinError);
	state.child.stdout.on("error", onStdoutError);
	state.child.stderr.on("error", onStderrError);
	state.child.on("exit", onExit);
	state.child.on("error", onError);
};

const runStartup = async (lifecycle: Lifecycle, options: ZigBackendOptions, restart: boolean): Promise<void> => {
	if (restart) await waitForRestartWindow(lifecycle);
	if (lifecycle.disposed) return Promise.reject(createShutdownError());

	const resolution = resolveInstalledExecutable();
	if (resolution.kind !== "resolved") {
		reportDiagnostic(options, resolution.message);
		return Promise.reject(new Error(resolution.message));
	}
	const spawned = attemptSpawn(resolution.executable);
	if (spawned.kind === "failed") {
		reportDiagnostic(options, spawned.error.message);
		return Promise.reject(spawned.error);
	}

	const state = createProcessState(spawned.child);
	lifecycle.child = state;
	attachProcess(lifecycle, options, state);
	const handshakeError = await completeHandshake(lifecycle, state);
	if (handshakeError !== undefined) {
		terminateProcess(lifecycle, options, state, handshakeError.message, !lifecycle.disposed);
		return Promise.reject(handshakeError);
	}
	if (lifecycle.disposed) {
		terminateProcess(lifecycle, options, state, createShutdownError().message, false);
		return Promise.reject(createShutdownError());
	}
	return;
};

const releaseStartup = (lifecycle: Lifecycle, startup: Promise<void>): void => {
	if (lifecycle.startup === startup) lifecycle.startup = undefined;
};

const beginStartup = (lifecycle: Lifecycle, options: ZigBackendOptions): Promise<void> => {
	const reservation = reserveStartAttempt(lifecycle);
	if (reservation.kind === "exhausted") {
		reportDiagnostic(options, reservation.error.message);
		return Promise.reject(reservation.error);
	}
	const startup = runStartup(lifecycle, options, reservation.restart);
	lifecycle.startup = startup;
	startup.then(
		() => releaseStartup(lifecycle, startup),
		() => releaseStartup(lifecycle, startup),
	);
	return startup;
};

const ensureProcess = (lifecycle: Lifecycle, options: ZigBackendOptions): Promise<void> => {
	if (lifecycle.disposed) return Promise.reject(createShutdownError());
	if (lifecycle.child !== undefined && !lifecycle.child.finalized) return Promise.resolve();
	if (lifecycle.startup !== undefined) return lifecycle.startup;
	return beginStartup(lifecycle, options);
};

const sendShutdownRequest = (lifecycle: Lifecycle, state: BackendProcess): void => {
	const id = allocateRequestId(lifecycle);
	const body = Buffer.from(JSON.stringify({ jsonrpc: "2.0", id, method: "shutdown" }), "utf8");
	writeFramedBody(state.child.stdin, body, () => {
		/* The grace timer remains the authority for a process that cannot answer. */
	});
	state.child.stdin.end();
};

export const createZigBackend = (options: ZigBackendOptions = {}): ZigBackend => {
	const lifecycle: Lifecycle = {
		disposed: false,
		child: undefined,
		startup: undefined,
		pending: new Map(),
		nextRequestId: 1,
		startAttempts: 0,
		restartsUsed: 0,
		restartGate: undefined,
		shutdownPromise: undefined,
		shutdownResolve: undefined,
		shutdownTimer: undefined,
		capabilities: { lex: false, parse: false, symbols: false },
		capabilitiesKnown: false,
	};

	const withProcess = <T>(
		signal: AbortSignal | undefined,
		run: (state: BackendProcess) => Promise<T>,
	): Promise<T> => {
		if (signal?.aborted === true) return Promise.reject(createAbortError());
		return ensureProcess(lifecycle, options).then(() => {
			if (lifecycle.disposed) return Promise.reject(createShutdownError());
			const state = lifecycle.child;
			if (state === undefined) return Promise.reject(new Error("Zig backend process is not available."));
			return run(state);
		});
	};

	/** Health advertises `symbols` only for builds that carry the native store. */
	const symbolsUnavailable = (): Promise<never> =>
		Promise.reject(new Error("Zig backend does not advertise the symbols capability."));

	const lex = (source: string, tokenOptions: ZigBackendTokenOptions = {}): Promise<GDScriptToken[]> => {
		const signal = tokenOptions.signal;
		if (signal?.aborted === true) return Promise.reject(createAbortError());
		return ensureProcess(lifecycle, options).then(() => {
			if (lifecycle.disposed) return Promise.reject(createShutdownError());
			const state = lifecycle.child;
			if (state === undefined) return Promise.reject(new Error("Zig backend process is not available."));
			return requestLex(lifecycle, state, source, signal);
		});
	};

	/** `parse` arrived in backend 0.3.0; older binaries fail the handshake check here. */
	const parseUnavailable = (): Promise<never> =>
		Promise.reject(new Error("Zig backend does not advertise the parse capability."));

	const parse = (source: string, tokenOptions: ZigBackendTokenOptions = {}): Promise<GDScriptParseResult> => {
		const signal = tokenOptions.signal;
		if (signal?.aborted === true) return Promise.reject(createAbortError());
		return ensureProcess(lifecycle, options).then(() => {
			if (lifecycle.disposed) return Promise.reject(createShutdownError());
			const state = lifecycle.child;
			if (state === undefined) return Promise.reject(new Error("Zig backend process is not available."));
			if (!lifecycle.capabilities.parse) return parseUnavailable();
			return requestParse(lifecycle, state, source, signal);
		});
	};

	const ingestSymbols = (
		revision: number,
		files: readonly ZigBackendFileSymbols[],
		tokenOptions: ZigBackendTokenOptions = {},
	): Promise<ZigBackendIngestResult> => {
		if (!lifecycle.capabilities.symbols) return symbolsUnavailable();
		return withProcess(tokenOptions.signal, (state) => {
			const expectedUris = files.map((file) => file.uri);
			return requestSymbols(
				lifecycle,
				state,
				"ingest",
				{ revision, files },
				tokenOptions.signal,
				"Zig backend returned a malformed symbol ingest result.",
				(value: unknown) => parseIngestResult(expectedUris, value),
			);
		});
	};

	const removeSymbols = (
		revision: number,
		uri: string,
		tokenOptions: ZigBackendTokenOptions = {},
	): Promise<number> => {
		if (!lifecycle.capabilities.symbols) return symbolsUnavailable();
		return withProcess(tokenOptions.signal, (state) =>
			requestSymbols(
				lifecycle,
				state,
				"remove",
				{ revision, uri },
				tokenOptions.signal,
				"Zig backend returned a malformed symbol remove result.",
				parseRevisionResult,
			),
		);
	};

	const parseQueryIds = (value: unknown): Uint32Array | undefined => {
		if (!isRecord(value)) return undefined;
		if (readOffset(value, "revision") === undefined) return undefined;
		return decodeIds(value["idsBase64"]);
	};

	const querySymbols = (
		revision: number,
		query: string,
		tokenOptions: ZigBackendTokenOptions = {},
	): Promise<Uint32Array> => {
		if (!lifecycle.capabilities.symbols) return symbolsUnavailable();
		return withProcess(tokenOptions.signal, (state) =>
			requestSymbols(
				lifecycle,
				state,
				"query",
				{ revision, query },
				tokenOptions.signal,
				"Zig backend returned a malformed symbol query result.",
				parseQueryIds,
			),
		);
	};

	const digestSymbols = (tokenOptions: ZigBackendTokenOptions = {}): Promise<ZigBackendDigest> => {
		if (!lifecycle.capabilities.symbols) return symbolsUnavailable();
		return withProcess(tokenOptions.signal, (state) =>
			requestSymbols(
				lifecycle,
				state,
				"digest",
				undefined,
				tokenOptions.signal,
				"Zig backend returned a malformed symbol digest result.",
				parseDigestResult,
			),
		);
	};

	const clearSymbols = (
		revision: number,
		tokenOptions: ZigBackendTokenOptions = {},
	): Promise<number> => {
		if (!lifecycle.capabilities.symbols) return symbolsUnavailable();
		return withProcess(tokenOptions.signal, (state) =>
			requestSymbols(
				lifecycle,
				state,
				"clear",
				{ revision },
				tokenOptions.signal,
				"Zig backend returned a malformed symbol clear result.",
				parseRevisionResult,
			),
		);
	};

	const shutdown = (): Promise<void> => {
		if (lifecycle.shutdownPromise !== undefined) return lifecycle.shutdownPromise;
		lifecycle.disposed = true;
		const promise = new Promise<void>((resolve) => {
			lifecycle.shutdownResolve = resolve;
		});
		lifecycle.shutdownPromise = promise;
		cancelRestartWindow(lifecycle);
		rejectAllPending(lifecycle, createShutdownError());

		const state = lifecycle.child;
		if (state === undefined) {
			completeShutdown(lifecycle);
			return promise;
		}
		sendShutdownRequest(lifecycle, state);
		lifecycle.shutdownTimer = setTimeout(() => {
			lifecycle.shutdownTimer = undefined;
			if (state.finalized) return;
			terminateProcess(
				lifecycle,
				options,
				state,
				"Zig backend did not exit within the shutdown grace period.",
				false,
			);
		}, SHUTDOWN_GRACE_MS);
		return promise;
	};

	return {
		lex,
		parse,
		get capabilities(): ZigBackendCapabilities {
			return { ...lifecycle.capabilities };
		},
		ingestSymbols,
		removeSymbols,
		querySymbols,
		digestSymbols,
		clearSymbols,
		shutdown,
	};
};

export const zigBackendRequiresBuiltBinary = (environment: Readonly<Record<string, string | undefined>>): boolean =>
	environment[REQUIRE_BACKEND_ENVIRONMENT_KEY] === "1";
