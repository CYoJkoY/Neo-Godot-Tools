import { GDScriptToken, lexGDScript } from "../analyzer/index.js";

/**
 * Lexed tokens of an indexed file, shared by every consumer that needs them.
 *
 * The binding builder, the type resolver and the receiver-chain parser all walk
 * the same token stream. Lexing a file used to happen once per function for the
 * local-declaration scan and once per function for the statement scan, which
 * made a file with `n` functions cost `O(n²)` characters. The cache keys on the
 * source fingerprint, so a file is lexed once per edit.
 */

interface CachedTokens {
	fingerprint: string;
	tokens: GDScriptToken[];
}

/** Files kept in memory; bounded so long sessions cannot grow without limit. */
const MAX_CACHED_FILES = 256;

const cache = new Map<string, CachedTokens>();

export function tokensFor(uri: string, source: string, fingerprint: string): GDScriptToken[] {
	const cached = cache.get(uri);
	if (cached && cached.fingerprint === fingerprint) {
		// Re-insert to keep the map ordered by recency for eviction.
		cache.delete(uri);
		cache.set(uri, cached);
		return cached.tokens;
	}
	const tokens = lexGDScript(source);
	cache.set(uri, { fingerprint, tokens });
	while (cache.size > MAX_CACHED_FILES) {
		const oldest = cache.keys().next();
		if (oldest.done) break;
		cache.delete(oldest.value);
	}
	return tokens;
}

export function forgetTokens(uri: string): void {
	cache.delete(uri);
}

export function clearTokenCache(): void {
	cache.clear();
}
