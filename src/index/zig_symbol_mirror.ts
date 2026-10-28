/**
 * Native workspace symbol mirror for the Zig analysis sidecar.
 *
 * `src/index/symbol_index.ts` stays authoritative: it owns the symbol objects
 * and the ordering contract. This module keeps a printable-ASCII copy of the
 * same table in the sidecar, so a workspace query returns an ordered id vector
 * instead of flattening, filtering and sorting every symbol on the extension
 * host thread. Any condition the native store cannot represent (missing
 * binary, a host collation that disagrees with the native order, non-ASCII
 * names) turns the mirror off and leaves the TypeScript path in charge.
 */

import {
	type ZigBackend,
	type ZigBackendIngestResult,
	type ZigBackendSymbolInput,
	createZigBackend,
} from "../backend/zig_backend.js";
import { withTimeout } from "../utils/scheduling.js";
import { asciiCollationSupported, isPrintableAscii } from "./ascii_collation.js";
import type { FileIndex } from "./file_index.js";
import type { IndexedSymbol } from "./symbol.js";

/**
 * Bytes reserved per symbol and per file when a flush is split into requests.
 * JSON escaping only ever shrinks this budget, so the estimate is an upper
 * bound for printable ASCII payloads.
 */
const SYMBOL_BYTES = 48;
const FILE_BYTES = 32;
const MAX_REQUEST_BYTES = 8 * 1024 * 1024;
const MAX_BATCH_FILES = 2048;
/** Bounds the drain so a busy editor cannot keep one query waiting forever. */
const MAX_DRAIN_ROUNDS = 8;
const MAX_CACHED_QUERIES = 128;
/** Above this many deletions a full resync is cheaper than one call per uri. */
const MASS_REMOVAL_FILES = 64;
const FLUSH_DELAY_MS = 16;
const QUERY_TIMEOUT_MS = 150;

export interface ZigSymbolMirrorFile {
	readonly uri: string;
	readonly symbols: readonly IndexedSymbol[];
}

export interface ZigSymbolMirrorOptions {
	/** Authoritative index contents, read when the native copy must be rebuilt. */
	readonly snapshot: () => readonly ZigSymbolMirrorFile[];
	readonly backend?: ZigBackend;
}

export interface ZigSymbolMirror {
	/** Mirrors one file; repeated calls before a flush keep only the last state. */
	upsert(uri: string, symbols: readonly IndexedSymbol[]): void;
	remove(uri: string): void;
	clear(): void;
	/**
	 * Symbols in index order, or `undefined` whenever the caller must use the
	 * TypeScript index instead.
	 */
	workspaceSymbols(query: string): Promise<readonly IndexedSymbol[] | undefined>;
	dispose(): void;
}

interface PendingFile {
	readonly uri: string;
	readonly symbols: readonly IndexedSymbol[];
	readonly stamp: number;
}

interface BoundId {
	readonly id: number;
	readonly symbol: IndexedSymbol;
}

const toInput = (symbol: IndexedSymbol): ZigBackendSymbolInput => ({
	name: symbol.name,
	start: symbol.range.start.offset,
	end: symbol.range.end.offset,
});

const fileBytes = (uri: string, symbols: readonly IndexedSymbol[]): number =>
	FILE_BYTES + uri.length + symbols.reduce((sum, symbol) => sum + SYMBOL_BYTES + symbol.name.length, 0);

const isStaleRevision = (error: unknown): boolean =>
	error instanceof Error && error.message.includes("stale revision");

/** Pairs each native id with the symbol it was built from; ids and symbols align. */
const bindIds = (ids: Uint32Array, symbols: readonly IndexedSymbol[]): readonly BoundId[] =>
	Array.from(ids, (id, index) => ({ id, symbol: symbols[index] })).filter(
		(entry): entry is BoundId => entry.symbol !== undefined,
	);

const isAsciiFile = (file: ZigSymbolMirrorFile): boolean =>
	isPrintableAscii(file.uri) && file.symbols.every((symbol) => isPrintableAscii(symbol.name));

/*** Snapshot of the authoritative index, used to rebuild the native copy. */
export const indexedSymbolFiles = (files: FileIndex): readonly ZigSymbolMirrorFile[] =>
	[...files.values()].map((file) => ({ uri: file.uri, symbols: file.symbols }));

export function createZigSymbolMirror(options: ZigSymbolMirrorOptions): ZigSymbolMirror {
	const backend = options.backend ?? createZigBackend();
	// A caller that supplies a backend keeps its lifecycle; only a backend the
	// mirror created is shut down together with the mirror.
	const ownsBackend = options.backend === undefined;
	const upserts = new Map<string, PendingFile>();
	const removals = new Map<string, number>();
	const symbolsById = new Map<number, IndexedSymbol>();
	const idsByUri = new Map<string, Uint32Array>();
	const queryCache = new Map<string, readonly IndexedSymbol[]>();
	const state = {
		revision: 0,
		stamp: 0,
		timer: undefined as ReturnType<typeof setTimeout> | undefined,
		inFlight: undefined as Promise<boolean> | undefined,
		/** The native store holds every symbol of the authoritative index. */
		synced: false,
		/** The sidecar is missing, incompatible or the host collation differs. */
		unavailable: false,
		/** Every name and uri offered so far is printable ASCII. */
		applicable: true,
		disposed: false,
	};

	const synchronized = (): boolean =>
		state.synced &&
		!state.disposed &&
		!state.unavailable &&
		state.applicable &&
		upserts.size === 0 &&
		removals.size === 0;

	const cacheQuery = (query: string, symbols: readonly IndexedSymbol[]): readonly IndexedSymbol[] => {
		if (queryCache.size >= MAX_CACHED_QUERIES) queryCache.clear();
		queryCache.set(query, symbols);
		return symbols;
	};

	/** Maps a native id vector back to symbols, rejecting ids it never issued. */
	const readIds = (query: string, ids: Uint32Array): readonly IndexedSymbol[] | undefined => {
		const symbols = ids.reduce<IndexedSymbol[]>((list, id) => {
			const symbol = symbolsById.get(id);
			if (symbol !== undefined) list.push(symbol);
			return list;
		}, []);
		if (symbols.length !== ids.length) return undefined;
		return cacheQuery(query, symbols);
	};

	const forgetUri = (uri: string): void => {
		const ids = idsByUri.get(uri);
		if (ids === undefined) return;
		Array.from(ids).map((id) => symbolsById.delete(id));
		idsByUri.delete(uri);
	};

	const applyIngest = (result: ZigBackendIngestResult, request: readonly ZigSymbolMirrorFile[]): boolean => {
		const requested = new Map(request.map((file) => [file.uri, file.symbols] as const));
		const applied = result.files.every((file) => (requested.get(file.uri)?.length ?? -1) === file.ids.length);
		if (!applied) return false;
		result.files.map((file) => {
			forgetUri(file.uri);
			bindIds(file.ids, requested.get(file.uri) ?? []).map((entry) => symbolsById.set(entry.id, entry.symbol));
			idsByUri.set(file.uri, file.ids);
		});
		return true;
	};

	const ingestBatch = async (batch: readonly PendingFile[]): Promise<boolean> => {
		const revision = state.revision + 1;
		const request = batch.map((file) => ({ uri: file.uri, symbols: file.symbols.map(toInput) }));
		// A failed request leaves the native copy unknown; the caller marks it
		// unsynchronized so the next flush rebuilds from the snapshot.
		const result = await backend.ingestSymbols(revision, request).catch(() => undefined);
		if (result === undefined) return false;
		if (!applyIngest(result, batch)) return false;
		state.revision = result.revision;
		queryCache.clear();
		return true;
	};

	const takeBatch = (entries: readonly PendingFile[]): readonly PendingFile[] =>
		entries.reduce<{ readonly files: PendingFile[]; bytes: number }>(
			(accumulator, entry) => {
				const bytes = accumulator.bytes + fileBytes(entry.uri, entry.symbols);
				const full = accumulator.files.length >= MAX_BATCH_FILES || bytes > MAX_REQUEST_BYTES;
				if (accumulator.files.length > 0 && full) return accumulator;
				accumulator.files.push(entry);
				accumulator.bytes = bytes;
				return accumulator;
			},
			{ files: [], bytes: 0 },
		).files;

	const drainUpserts = async (round: number): Promise<boolean> => {
		if (round >= MAX_DRAIN_ROUNDS) return true;
		const pending = [...upserts].map(([uri, entry]) => ({ uri, symbols: entry.symbols, stamp: entry.stamp }));
		const batch = takeBatch(pending);
		if (!batch.length) return true;
		const applied = await ingestBatch(batch);
		if (!applied) return false;
		// An edit that arrived while the request was in flight keeps its newer
		// stamp, so the next round sends it instead of dropping it.
		batch
			.filter((file) => upserts.get(file.uri)?.stamp === file.stamp)
			.map((file) => upserts.delete(file.uri));
		return drainUpserts(round + 1);
	};

	/** A single file larger than one request cannot be mirrored; fall back. */
	const disableForOversize = (files: readonly ZigSymbolMirrorFile[]): void => {
		if (!files.some((file) => fileBytes(file.uri, file.symbols) > MAX_REQUEST_BYTES)) return;
		state.applicable = false;
		upserts.clear();
		removals.clear();
		queryCache.clear();
	};

	const drainRemovals = async (): Promise<boolean> => {
		const next = [...removals].find(() => true);
		if (next === undefined) return true;
		const [uri, stamp] = next;
		const revision = state.revision + 1;
		const applied = await backend.removeSymbols(revision, uri).catch(() => undefined);
		if (applied === undefined) return false;
		state.revision = applied;
		forgetUri(uri);
		queryCache.clear();
		if (removals.get(uri) === stamp) removals.delete(uri);
		return drainRemovals();
	};

	const ingestAll = async (files: readonly ZigSymbolMirrorFile[]): Promise<boolean> => {
		const batch = takeBatch(files.map((file) => ({ uri: file.uri, symbols: file.symbols, stamp: 0 })));
		if (!batch.length) return true;
		const applied = await ingestBatch(batch);
		if (!applied) return false;
		const sent = new Set(batch.map((file) => file.uri));
		return ingestAll(files.filter((file) => !sent.has(file.uri)));
	};

	/**
	 * Rebuilds the native store from the authoritative index and proves the
	 * result with a digest, so a restarted sidecar can never serve a partial
	 * table.
	 */
	const resync = async (): Promise<boolean> => {
		const stamp = state.stamp;
		const snapshot = options.snapshot();
		if (!snapshot.every(isAsciiFile)) {
			state.applicable = false;
			upserts.clear();
			removals.clear();
			queryCache.clear();
			return false;
		}
		disableForOversize(snapshot);
		if (!state.applicable) return false;
		// Another client may have advanced the shared table; the digest reports
		// the revision the sidecar holds, and every mutation has to move past it.
		const current = await backend.digestSymbols().catch(() => undefined);
		if (current === undefined) return false;
		const revision = Math.max(current.revision, state.revision) + 1;
		const cleared = await backend.clearSymbols(revision).catch(() => undefined);
		if (cleared === undefined) return false;
		state.revision = cleared;
		symbolsById.clear();
		idsByUri.clear();
		queryCache.clear();
		if (!(await ingestAll(snapshot))) return false;
		const digest = await backend.digestSymbols().catch(() => undefined);
		const expected = snapshot.reduce((sum, file) => sum + file.symbols.length, 0);
		if (digest === undefined || digest.files !== snapshot.length || digest.symbols !== expected) return false;
		state.synced = true;
		upserts.forEach((entry, uri) => {
			if (entry.stamp <= stamp) upserts.delete(uri);
		});
		removals.forEach((entry, uri) => {
			if (entry <= stamp) removals.delete(uri);
		});
		// The empty query is what every first completion asks for; paying it now
		// keeps the first keystroke off the cold path.
		const prewarmRevision = state.revision;
		void backend.querySymbols(prewarmRevision, "").then(
			(ids) => (state.revision === prewarmRevision ? readIds("", ids) : undefined),
			() => undefined,
		);
		return true;
	};

	const applyPending = async (): Promise<boolean> => {
		if (removals.size > MASS_REMOVAL_FILES) return resync();
		if (!(await drainRemovals())) return false;
		return drainUpserts(0);
	};

	/**
	 * Symbol capabilities are only reported by the process that answered the
	 * handshake, so the very first symbol call has to follow one.
	 */
	const ensureReady = (): Promise<boolean> => {
		if (state.unavailable || state.disposed) return Promise.resolve(false);
		if (!asciiCollationSupported()) {
			state.unavailable = true;
			return Promise.resolve(false);
		}
		if (backend.capabilities.symbols) return Promise.resolve(true);
		return backend.lex("").then(
			() => {
				if (backend.capabilities.symbols) return true;
				state.unavailable = true;
				return false;
			},
			() => {
				state.unavailable = true;
				return false;
			},
		);
	};

	const flush = async (): Promise<boolean> => {
		if (state.disposed || !state.applicable || state.unavailable) return false;
		// A fresh process starts with an empty store, so its first flush has to
		// rebuild instead of trusting the revision we tracked before.
		const connected = backend.capabilities.symbols;
		if (!(await ensureReady())) {
			upserts.clear();
			removals.clear();
			return false;
		}
		if (!connected) state.synced = false;
		// A resync rebuilds the table from the authoritative index, then the
		// files edited while it ran still have to be replayed on top of it.
		if (!state.synced && !(await resync())) return false;
		const applied = await applyPending();
		if (applied) return true;
		state.synced = false;
		// A second client can advance the shared revision between our digest and
		// our mutation. Rebuild once and replay the queue on the newer table.
		if (!(await resync())) return false;
		const retried = await applyPending();
		if (!retried) state.synced = false;
		return retried;
	};

	const flushNow = (): Promise<boolean> => {
		const current = state.inFlight;
		if (current !== undefined) return current;
		const work = flush().then(
			(applied) => {
				state.inFlight = undefined;
				return applied;
			},
			() => {
				state.inFlight = undefined;
				return false;
			},
		);
		state.inFlight = work;
		return work;
	};

	const scheduleFlush = (): void => {
		if (state.timer !== undefined) return;
		state.timer = setTimeout(() => {
			state.timer = undefined;
			void flushNow();
		}, FLUSH_DELAY_MS);
	};

	const queryNative = (query: string, retried: boolean): Promise<readonly IndexedSymbol[] | undefined> => {
		const revision = state.revision;
		return backend.querySymbols(revision, query).then(
			// Ids only mean something while the table that issued them is current;
			// a concurrent flush bumps the revision and falls back to the index.
			(ids) => (state.revision === revision ? readIds(query, ids) : undefined),
			(error: unknown) => {
				// A restarted sidecar reports the revision it was recreated with.
				if (retried || !isStaleRevision(error)) return undefined;
				state.synced = false;
				return resync().then((restored) => (restored ? queryNative(query, true) : undefined));
			},
		);
	};

	const workspaceSymbols = async (query: string): Promise<readonly IndexedSymbol[] | undefined> => {
		if (state.disposed || !state.applicable || state.unavailable) return undefined;
		if (!isPrintableAscii(query)) return undefined;
		// A cached result is only trustworthy while the native table matches the
		// authoritative index; a pending edit invalidates it just like a flush.
		if (synchronized()) {
			const cached = queryCache.get(query);
			if (cached !== undefined) return cached;
		}
		const flushed = await withTimeout(flushNow(), QUERY_TIMEOUT_MS);
		if (flushed !== true || !synchronized()) return undefined;
		return queryNative(query, false);
	};

	const upsert = (uri: string, symbols: readonly IndexedSymbol[]): void => {
		if (state.disposed || state.unavailable || !state.applicable) return;
		state.stamp += 1;
		upserts.set(uri, { uri, symbols, stamp: state.stamp });
		removals.delete(uri);
		if (isPrintableAscii(uri) && symbols.every((symbol) => isPrintableAscii(symbol.name))) {
			disableForOversize([{ uri, symbols }]);
			if (state.applicable) scheduleFlush();
			return;
		}
		state.applicable = false;
		upserts.clear();
		removals.clear();
		queryCache.clear();
	};

	const remove = (uri: string): void => {
		if (state.disposed || state.unavailable || !state.applicable) return;
		if (!isPrintableAscii(uri)) {
			state.applicable = false;
			upserts.clear();
			removals.clear();
			queryCache.clear();
			return;
		}
		// A file whose symbols were never flushed is gone with its pending entry;
		// a file the native store already accepted needs an explicit removal, even
		// when a newer edit of it is still queued.
		upserts.delete(uri);
		if (!idsByUri.has(uri) && !removals.has(uri)) return;
		state.stamp += 1;
		removals.set(uri, state.stamp);
		scheduleFlush();
	};

	const clear = (): void => {
		if (state.disposed) return;
		upserts.clear();
		removals.clear();
		symbolsById.clear();
		idsByUri.clear();
		queryCache.clear();
		// The native store still holds the old table; the next flush rebuilds it.
		state.synced = false;
	};

	const dispose = (): void => {
		if (state.disposed) return;
		state.disposed = true;
		if (state.timer !== undefined) clearTimeout(state.timer);
		state.timer = undefined;
		upserts.clear();
		removals.clear();
		symbolsById.clear();
		idsByUri.clear();
		queryCache.clear();
		if (ownsBackend) void backend.shutdown().catch(() => undefined);
	};

	return { upsert, remove, clear, workspaceSymbols, dispose };
}
