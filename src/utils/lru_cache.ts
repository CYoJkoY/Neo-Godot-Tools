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

interface Entry<V> {
	value: V;
	storedAt: number;
}

export class LruCache<K, V> {
	private readonly entries = new Map<K, Entry<V>>();
	private readonly capacity: number;
	private readonly ttlMs: number | undefined;

	constructor(options: LruCacheOptions = {}) {
		this.capacity = Math.max(1, options.capacity ?? 256);
		this.ttlMs = options.ttlMs;
	}

	get size(): number {
		return this.entries.size;
	}

	has(key: K): boolean {
		return this.lookup(key) !== undefined;
	}

	get(key: K): V | undefined {
		return this.lookup(key)?.value;
	}

	set(key: K, value: V): void {
		this.entries.delete(key);
		this.entries.set(key, { value, storedAt: Date.now() });
		while (this.entries.size > this.capacity) {
			const oldest = this.entries.keys().next();
			if (oldest.done) break;
			this.entries.delete(oldest.value);
		}
	}

	delete(key: K): void {
		this.entries.delete(key);
	}

	clear(): void {
		this.entries.clear();
	}

	/** Entries in insertion order, least recently used first. */
	*keys(): IterableIterator<K> {
		yield* this.entries.keys();
	}

	/** Entry for `key`, refreshed by recency, or `undefined` when absent or stale. */
	private lookup(key: K): Entry<V> | undefined {
		const entry = this.entries.get(key);
		if (!entry) return undefined;
		if (this.ttlMs !== undefined && Date.now() - entry.storedAt > this.ttlMs) {
			this.entries.delete(key);
			return undefined;
		}
		// Re-insert so the eviction order reflects recency.
		this.entries.delete(key);
		this.entries.set(key, entry);
		return entry;
	}
}
