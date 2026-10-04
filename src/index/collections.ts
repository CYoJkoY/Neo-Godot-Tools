/**
 * Map accumulation helpers shared by the index layers.
 *
 * The index passes build several maps of maps, sets and lists. Keeping the
 * accumulation here means a call site reads as a guard clause - name the bucket,
 * hand over the value - instead of carrying a nested loop, and it keeps the
 * "create the bucket on first use, drop it when it empties" rule in one place.
 */

/** Appends `value` to the list under `key`, creating the list on first use. */
export function addToGroup<K, V>(map: Map<K, V[]>, key: K, value: V): void {
	const entries = map.get(key);
	if (entries) {
		entries.push(value);
		return;
	}
	map.set(key, [value]);
}

/** Adds `value` to the set under `key`, creating the set on first use. */
export function addToSet<K, V>(map: Map<K, Set<V>>, key: K, value: V): void {
	const entries = map.get(key) ?? new Set<V>();
	entries.add(value);
	map.set(key, entries);
}

/** Removes `value` from the set under `key`, dropping the key when it empties. */
export function dropFromSet<K, V>(map: Map<K, Set<V>>, key: K, value: V): void {
	const entries = map.get(key);
	if (!entries) return;
	entries.delete(value);
	if (!entries.size) map.delete(key);
}

/** Removes every entry under `key` matching `matches`; the key goes with its last entry. */
export function dropFromGroup<K, V>(map: Map<K, V[]>, key: K, matches: (value: V) => boolean): void {
	const entries = map.get(key);
	if (!entries) return;
	const remaining = entries.filter((entry) => !matches(entry));
	if (remaining.length) map.set(key, remaining);
	else map.delete(key);
}

/** Deletes every entry whose key/value matches; the map is the only state to touch. */
export function deleteMatching<K, V>(map: Map<K, V>, matches: (key: K, value: V) => boolean): void {
	[...map.entries()].filter(([key, value]) => matches(key, value)).map(([key]) => map.delete(key));
}
