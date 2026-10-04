/**
 * Small LRU cache with an optional TTL.
 *
 * Several long-lived indexes cache per-file or per-class data on module scope,
 * where a plain `Map` grows for the whole session: every script the user opens,
 * every scene they preview and every icon they resolve stays in memory even
 * after the project or file is gone. A bound keeps those caches proportional to
 * what is actually being worked on.
 */
export interface LruCacheOptions {
	/** Maximum number of entries. Defaults to 256. */
	capacity?: number;
	/** Entries older than this are treated as absent. */
	ttlMs?: number;
}

export interface LruCache<K, V> {
	readonly size: number;
	has(key: K): boolean;
	/** `undefined` when absent, stale, or evicted. */
	get(key: K): V | undefined;
	set(key: K, value: V): void;
	delete(key: K): void;
	clear(): void;
	/** Keys in insertion order, least recently used first. */
	keys(): IterableIterator<K>;
}

interface Entry<V> {
	value: V;
	storedAt: number;
}

export function createLruCache<K, V>(options: LruCacheOptions = {}): LruCache<K, V> {
	const capacity = Math.max(1, options.capacity ?? 256);
	const ttlMs = options.ttlMs;
	const entries = new Map<K, Entry<V>>();

	const dropOldest = (): void => {
		const oldest = entries.keys().next();
		if (!oldest.done) entries.delete(oldest.value);
	};

	/** Entry for `key`, refreshed by recency, or `undefined` when absent or stale. */
	const lookup = (key: K): Entry<V> | undefined => {
		const entry = entries.get(key);
		if (entry === undefined) return undefined;
		if (ttlMs !== undefined && Date.now() - entry.storedAt > ttlMs) {
			entries.delete(key);
			return undefined;
		}
		// Re-insert so the eviction order reflects recency.
		entries.delete(key);
		entries.set(key, entry);
		return entry;
	};

	return {
		get size(): number {
			return entries.size;
		},
		has: (key) => lookup(key) !== undefined,
		get: (key) => lookup(key)?.value,
		set: (key, value) => {
			entries.delete(key);
			entries.set(key, { value, storedAt: Date.now() });
			// Re-inserting an existing key cannot grow the map past capacity + 1.
			if (entries.size > capacity) dropOldest();
		},
		delete: (key) => {
			entries.delete(key);
		},
		clear: () => {
			entries.clear();
		},
		keys: () => entries.keys(),
	};
}
