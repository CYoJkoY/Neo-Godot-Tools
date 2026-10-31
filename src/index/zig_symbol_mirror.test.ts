import { strict as assert } from "node:assert";
import * as fs from "node:fs";
import { after, describe, it } from "node:test";

import {
	type ZigBackend,
	type ZigBackendDigest,
	type ZigBackendFileSymbols,
	type ZigBackendIngestResult,
	createZigBackend,
	resolveZigBackendExecutable,
	zigBackendRequiresBuiltBinary,
} from "../backend/zig_backend.js";
import type { SourceRange } from "../analyzer/index.js";
import { createFileIndex } from "./file_index.js";
import { createSymbolIndex, type SymbolIndex } from "./symbol_index.js";
import type { IndexedSymbol } from "./symbol.js";
import { createZigSymbolMirror, indexedSymbolFiles } from "./zig_symbol_mirror.js";

const isRegularFile = (candidate: string): boolean => {
	try {
		return fs.statSync(candidate).isFile();
	} catch {
		return false;
	}
};

const availability = resolveZigBackendExecutable(__dirname, process.env, process.platform, isRegularFile);
const requiresBinary = zigBackendRequiresBuiltBinary(process.env);
const binarySkip =
	availability.kind === "resolved" || requiresBinary
		? false
		: 'Zig backend binary is not built. Run "npm run build:backend", or set NEO_GODOT_TOOLS_REQUIRE_ZIG_BACKEND=1 to fail instead of skipping.';

interface Workspace {
	readonly files: ReturnType<typeof createFileIndex>;
	readonly symbols: SymbolIndex;
}

function workspace(sources: Readonly<Record<string, string>>): Workspace {
	const files = createFileIndex();
	const symbols = createSymbolIndex(files);
	for (const [uri, source] of Object.entries(sources)) {
		files.update(uri, source, 1);
		symbols.update(uri);
	}
	return { files, symbols };
}

const script = (name: string): string =>
	`class_name ${name}\nextends Node\n\nvar ${name}_value: int = 0\n\nfunc ${name}_run() -> void:\n\t${name}_value += 1\n`;

const range = (start: number, end: number): SourceRange => ({
	start: { offset: start, line: 0, character: start },
	end: { offset: end, line: 0, character: end },
});

/** Names chosen to cover punctuation, digit and letter case collation. */
const COLLATION_SOURCES: Readonly<Record<string, string>> = {
	"file:///project/script_10.gd": script("ScriptTen"),
	"file:///project/script_2.gd": script("ScriptTwo"),
	"file:///project/getter.gd": "extends Node\n\nvar get_value := 1\n\nvar getValue := 2\n",
	"file:///project/case.gd": "extends Node\n\nvar Alpha := 1\n\nvar alpha := 2\n\nvar Zulu := 3\n",
};

interface Queryable {
	workspaceSymbols(query: string): Promise<readonly IndexedSymbol[] | undefined>;
}

/**
 * Waits for the first native flush. It can outlive the per-query budget while
 * the suite is busy, and the abandoned wait keeps running in the background.
 */
async function awaitNative(mirror: Queryable, query = ""): Promise<void> {
	const deadline = Date.now() + 10_000;
	for (;;) {
		if ((await mirror.workspaceSymbols(query)) !== undefined) return;
		if (Date.now() > deadline) throw new Error("the native mirror never became ready");
		await new Promise((resolve) => setTimeout(resolve, 20));
	}
}

async function compareQueries(
	index: Workspace,
	mirror: Queryable,
	queries: readonly string[],
): Promise<void> {
	for (const query of queries) {
		const expected = index.symbols.workspaceSymbols(query);
		const actual = await mirror.workspaceSymbols(query);
		assert.notEqual(actual, undefined, `the mirror refused the query ${JSON.stringify(query)}`);
		assert.deepEqual([...(actual ?? [])], expected, `query ${JSON.stringify(query)}`);
	}
}

/** Polls a condition that a background flush has to satisfy. */
async function waitFor(condition: () => boolean, label: string): Promise<void> {
	const deadline = Date.now() + 10_000;
	while (!condition()) {
		if (Date.now() > deadline) throw new Error(`timed out waiting for ${label}`);
		await new Promise((resolve) => setTimeout(resolve, 20));
	}
}

interface MemoryBackendOptions {
	/** Resolves before the first ingest answers, to hold it in flight. */
	readonly gate?: Promise<void>;
	/** Called with the uris of every ingest and the uri of every removal. */
	readonly onIngest?: (uris: readonly string[]) => void;
	readonly onRemove?: (uri: string) => void;
}

/** Keeps the native table in memory, so a flush can succeed without the binary. */
function memoryBackend(options: MemoryBackendOptions = {}): ZigBackend {
	let revision = 0;
	let nextId = 1;
	const idsByUri = new Map<string, Uint32Array>();
	return backendStub({
		ingestSymbols: async (next, files): Promise<ZigBackendIngestResult> => {
			options.onIngest?.(files.map((file) => file.uri));
			await options.gate;
			for (const file of files) idsByUri.set(file.uri, new Uint32Array(file.symbols.map(() => nextId++)));
			revision = next;
			return {
				revision: next,
				files: files.map((file) => ({ uri: file.uri, ids: idsByUri.get(file.uri) ?? new Uint32Array() })),
			};
		},
		removeSymbols: async (next, uri) => {
			options.onRemove?.(uri);
			idsByUri.delete(uri);
			revision = next;
			return next;
		},
		clearSymbols: async (next) => {
			idsByUri.clear();
			revision = next;
			return next;
		},
		digestSymbols: async (): Promise<ZigBackendDigest> => ({
			revision,
			files: idsByUri.size,
			symbols: [...idsByUri.values()].reduce((total, ids) => total + ids.length, 0),
		}),
		querySymbols: async () => new Uint32Array([...idsByUri.values()].flatMap((ids) => [...ids])),
	});
}

function backendStub(overrides: Partial<ZigBackend> = {}): ZigBackend {
	return {
		capabilities: { lex: true, parse: true, symbols: true },
		lex: async () => [],
		parse: async () => ({ ast: { kind: "script", range: range(0, 0), declarations: [] }, diagnostics: [] }),
		ingestSymbols: async (
			revision: number,
			files: readonly ZigBackendFileSymbols[],
		): Promise<ZigBackendIngestResult> => ({
			revision,
			files: files.map((file) => ({ uri: file.uri, ids: new Uint32Array(file.symbols.length) })),
		}),
		removeSymbols: async (revision: number) => revision,
		querySymbols: async () => new Uint32Array(),
		digestSymbols: async (): Promise<ZigBackendDigest> => ({ revision: 0, files: 0, symbols: 0 }),
		clearSymbols: async (revision: number) => revision,
		shutdown: async () => undefined,
		...overrides,
	};
}

describe("ZigSymbolMirror", () => {
	it("returns undefined when the symbol capability is missing", async () => {
		const index = workspace(COLLATION_SOURCES);
		const mirror = createZigSymbolMirror({
			snapshot: () => indexedSymbolFiles(index.symbols),
			backend: backendStub({ capabilities: { lex: true, parse: true, symbols: false } }),
		});
		try {
			assert.equal(await mirror.workspaceSymbols(""), undefined);
		} finally {
			mirror.dispose();
		}
	});

	it("returns undefined when the sidecar fails to start", async () => {
		const index = workspace(COLLATION_SOURCES);
		const mirror = createZigSymbolMirror({
			snapshot: () => indexedSymbolFiles(index.symbols),
			backend: backendStub({
				capabilities: { lex: false, parse: false, symbols: false },
				lex: async () => Promise.reject(new Error("missing executable")),
			}),
		});
		try {
			assert.equal(await mirror.workspaceSymbols(""), undefined);
			assert.equal(await mirror.workspaceSymbols("a"), undefined);
		} finally {
			mirror.dispose();
		}
	});

	it("returns undefined when the digest does not match the snapshot", async () => {
		const index = workspace(COLLATION_SOURCES);
		const mirror = createZigSymbolMirror({
			snapshot: () => indexedSymbolFiles(index.symbols),
			backend: backendStub({ digestSymbols: async () => ({ revision: 1, files: 0, symbols: 0 }) }),
		});
		try {
			assert.equal(await mirror.workspaceSymbols(""), undefined);
		} finally {
			mirror.dispose();
		}
	});

	it("returns undefined when a flush does not finish in time", async () => {
		const index = workspace(COLLATION_SOURCES);
		const mirror = createZigSymbolMirror({
			snapshot: () => indexedSymbolFiles(index.symbols),
			backend: backendStub({ clearSymbols: () => new Promise<number>(() => undefined) }),
		});
		try {
			const started = Date.now();
			assert.equal(await mirror.workspaceSymbols(""), undefined);
			assert.ok(Date.now() - started < 2000, "the query must be bounded by the flush timeout");
		} finally {
			mirror.dispose();
		}
	});

	it("falls back once a non ascii name is indexed", async () => {
		const index = workspace(COLLATION_SOURCES);
		const mirror = createZigSymbolMirror({
			snapshot: () => indexedSymbolFiles(index.symbols),
			backend: backendStub(),
		});
		try {
			mirror.upsert("file:///project/unicode.gd", [
				{ name: "h\u00e9llo", kind: "variable", uri: "file:///project/unicode.gd", range: range(0, 5) },
			]);
			assert.equal(await mirror.workspaceSymbols(""), undefined);
			assert.equal(await mirror.workspaceSymbols("get"), undefined);
		} finally {
			mirror.dispose();
		}
	});

	it("retries a rejected handshake before disabling the mirror", async () => {
		const index = workspace(COLLATION_SOURCES);
		const attempts: number[] = [];
		let symbolCapable = false;
		const messages: string[] = [];
		const mirror = createZigSymbolMirror({
			snapshot: () => indexedSymbolFiles(index.symbols),
			onDiagnostic: (message) => messages.push(message),
			backend: {
				...memoryBackend(),
				get capabilities() {
					return { lex: true, parse: true, symbols: symbolCapable };
				},
				lex: async () => {
					attempts.push(1);
					// The first handshake answers before the sidecar finished its
					// upgrade, which is exactly the transient case.
					if (attempts.length > 1) symbolCapable = true;
					return [];
				},
			},
		});
		try {
			for (const file of indexedSymbolFiles(index.symbols)) mirror.upsert(file.uri, file.symbols);
			const served = await mirror.workspaceSymbols("");
			assert.notEqual(served, undefined, "the retried handshake must serve the query");
			assert.equal((served ?? []).length, index.symbols.workspaceSymbols("").length);
			assert.equal(attempts.length, 2, "the handshake must be retried once");
			assert.deepEqual(messages, []);
		} finally {
			mirror.dispose();
		}
	});

	it("reports the error and stops after repeated handshake failures", async () => {
		const index = workspace(COLLATION_SOURCES);
		const messages: string[] = [];
		let attempts = 0;
		const mirror = createZigSymbolMirror({
			snapshot: () => indexedSymbolFiles(index.symbols),
			onDiagnostic: (message) => messages.push(message),
			backend: backendStub({
				capabilities: { lex: true, parse: true, symbols: false },
				lex: async () => {
					attempts += 1;
					return Promise.reject(new Error("the sidecar exited"));
				},
			}),
		});
		try {
			assert.equal(await mirror.workspaceSymbols(""), undefined);
			assert.equal(attempts, 2, "the retry is bounded");
			assert.equal(messages.length, 1);
			assert.match(messages[0] ?? "", /the sidecar exited/);
			// The mirror is off now, so no further handshake is attempted.
			assert.equal(await mirror.workspaceSymbols("get"), undefined);
			assert.equal(attempts, 2);
		} finally {
			mirror.dispose();
		}
	});

	it("stops rebuilding once flushes keep failing", async () => {
		const index = workspace(COLLATION_SOURCES);
		const messages: string[] = [];
		let ingests = 0;
		const mirror = createZigSymbolMirror({
			snapshot: () => indexedSymbolFiles(index.symbols),
			onDiagnostic: (message) => messages.push(message),
			backend: backendStub({
				ingestSymbols: async () => {
					ingests += 1;
					return Promise.reject(new Error("the sidecar is gone"));
				},
			}),
		});
		try {
			for (const file of indexedSymbolFiles(index.symbols)) mirror.upsert(file.uri, file.symbols);
			for (const query of ["", "get", "script", "alpha", "missing", "another"]) {
				assert.equal(await mirror.workspaceSymbols(query), undefined);
			}
			// The resync ingest is the first failure; the rebuild after it is the
			// second; the third stops the mirror, so no query past that ingests.
			assert.equal(ingests, 3, "the mirror must stop rebuilding after three failures");
			assert.equal(messages.length, 1);
			assert.match(messages[0] ?? "", /failed 3 times in a row: the sidecar is gone/);
		} finally {
			mirror.dispose();
		}
	});

	it("sends a removal issued while an ingest is pending", async () => {
		const index = workspace({
			"file:///project/kept.gd": script("Kept"),
			"file:///project/removed.gd": script("Removed"),
		});
		const removed = "file:///project/removed.gd";
		const removals: string[] = [];
		const ingested: string[] = [];
		const gate: { release: () => void } = { release: () => undefined };
		const held = new Promise<void>((resolve) => {
			gate.release = resolve;
		});
		const mirror = createZigSymbolMirror({
			snapshot: () => indexedSymbolFiles(index.symbols),
			// The gate holds the first ingest open, the way a large workspace scan
			// would, so the removal is issued while `idsByUri` is still empty.
			backend: memoryBackend({
				gate: held,
				onIngest: (uris) => ingested.push(...uris),
				onRemove: (uri) => removals.push(uri),
			}),
		});
		try {
			const query = mirror.workspaceSymbols("");
			await waitFor(() => ingested.includes(removed), "the first native ingest");
			mirror.remove(removed);
			gate.release();
			await query;
			await waitFor(() => removals.includes(removed), "the removal of the deleted file");
		} finally {
			mirror.dispose();
		}
	});

	describe("against the built sidecar", { skip: binarySkip }, () => {
		const backend = createZigBackend();
		after(() => backend.shutdown());
		const mirrorFor = (index: Workspace) =>
			createZigSymbolMirror({ snapshot: () => indexedSymbolFiles(index.symbols), backend });

		it("matches the TypeScript index order for every query", async () => {
			const index = workspace(COLLATION_SOURCES);
			const mirror = mirrorFor(index);
			try {
				for (const file of indexedSymbolFiles(index.symbols)) mirror.upsert(file.uri, file.symbols);
				await awaitNative(mirror);
				await compareQueries(index, mirror, ["", "get", "GET", "script", "S", "z", "run", "_2", "Alpha"]);
			} finally {
				mirror.dispose();
			}
		});

		it("keeps duplicate names across files ordered by uri", async () => {
			const sources: Readonly<Record<string, string>> = {
				"file:///project/b.gd": "extends Node\n\nfunc shared() -> void:\n\tpass\n",
				"file:///project/a.gd": "extends Node\n\nfunc shared() -> void:\n\tpass\n",
				"file:///project/c.gd": "extends Node\n\nvar unrelated := 1\n",
			};
			const index = workspace(sources);
			const mirror = mirrorFor(index);
			try {
				for (const file of indexedSymbolFiles(index.symbols)) mirror.upsert(file.uri, file.symbols);
				await awaitNative(mirror, "shared");
				await compareQueries(index, mirror, ["shared"]);
				const actual = await mirror.workspaceSymbols("shared");
				assert.deepEqual(
					(actual ?? []).map((symbol) => symbol.uri),
					["file:///project/a.gd", "file:///project/b.gd"],
				);
			} finally {
				mirror.dispose();
			}
		});

		it("follows upserts and removals", async () => {
			const index = workspace(COLLATION_SOURCES);
			const mirror = mirrorFor(index);
			try {
				for (const file of indexedSymbolFiles(index.symbols)) mirror.upsert(file.uri, file.symbols);
				await awaitNative(mirror);
				await compareQueries(index, mirror, [""]);
				const removed = "file:///project/getter.gd";
				index.symbols.remove(removed);
				index.files.remove(removed);
				mirror.remove(removed);
				await compareQueries(index, mirror, ["", "get"]);
				const added = "file:///project/added.gd";
				index.files.update(added, "extends Node\n\nfunc added_call() -> void:\n\tpass\n", 1);
				index.symbols.update(added);
				mirror.upsert(added, index.symbols.fileSymbols(added));
				await compareQueries(index, mirror, ["added", ""]);
			} finally {
				mirror.dispose();
			}
		});

		it("keeps the ranges the index captured across a body edit", async () => {
			const index = workspace({
				"file:///project/shift.gd": "extends Node\n\nfunc first() -> void:\n\tpass\n\nfunc second() -> void:\n\tpass\n",
			});
			const mirror = mirrorFor(index);
			try {
				for (const file of indexedSymbolFiles(index.symbols)) mirror.upsert(file.uri, file.symbols);
				await awaitNative(mirror, "second");
				await compareQueries(index, mirror, ["", "second"]);
				// A body edit shifts `second` without changing the API fingerprint.
				// The index keeps the captured ranges, so the mirror must agree.
				index.files.update(
					"file:///project/shift.gd",
					"extends Node\n\nfunc first() -> void:\n\tpass\n\tpass\n\tpass\n\nfunc second() -> void:\n\tpass\n",
					2,
				);
				await compareQueries(index, mirror, ["", "second"]);
			} finally {
				mirror.dispose();
			}
		});

		it("rebuilds the native table after a clear", async () => {
			const index = workspace(COLLATION_SOURCES);
			const mirror = mirrorFor(index);
			try {
				for (const file of indexedSymbolFiles(index.symbols)) mirror.upsert(file.uri, file.symbols);
				await awaitNative(mirror);
				await compareQueries(index, mirror, [""]);
				mirror.clear();
				await compareQueries(index, mirror, ["", "get"]);
			} finally {
				mirror.dispose();
			}
		});

		it("resyncs when another client replaced the native table", async () => {
			const first = workspace(COLLATION_SOURCES);
			const second = workspace({ "file:///other/only.gd": script("Other") });
			const firstMirror = mirrorFor(first);
			const secondMirror = mirrorFor(second);
			try {
				for (const file of indexedSymbolFiles(first.symbols)) firstMirror.upsert(file.uri, file.symbols);
				await awaitNative(firstMirror);
				await compareQueries(first, firstMirror, [""]);
				for (const file of indexedSymbolFiles(second.symbols)) secondMirror.upsert(file.uri, file.symbols);
				await awaitNative(secondMirror);
				await compareQueries(second, secondMirror, [""]);
				// The first mirror's tracked revision is stale now.
				await compareQueries(first, firstMirror, ["", "get"]);
			} finally {
				secondMirror.dispose();
				firstMirror.dispose();
			}
		});

		it("serves an empty workspace", async () => {
			const index = workspace({});
			const mirror = mirrorFor(index);
			try {
				assert.deepEqual([...(await mirror.workspaceSymbols("")) ?? []], []);
			} finally {
				mirror.dispose();
			}
		});

	});
});
