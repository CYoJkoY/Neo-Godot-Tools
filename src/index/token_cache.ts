import { GDScriptToken, lexGDScript } from "../analyzer/index.js";
import { createLruCache } from "../utils/lru_cache.js";

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
const cache = createLruCache<string, CachedTokens>({ capacity: 256 });

export function tokensFor(uri: string, source: string, fingerprint: string): GDScriptToken[] {
	const cached = cache.get(uri);
	if (cached && cached.fingerprint === fingerprint) return cached.tokens;
	const tokens = lexGDScript(source);
	cache.set(uri, { fingerprint, tokens });
	return tokens;
}

export function forgetTokens(uri: string): void {
	cache.delete(uri);
}

export function clearTokenCache(): void {
	cache.clear();
}
