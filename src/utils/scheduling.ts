import { performance } from "node:perf_hooks";

/**
 * Yields to the extension host's event loop.
 *
 * The extension host is a single Node.js thread shared by every installed
 * extension. Long synchronous loops inside this extension therefore freeze
 * unrelated extensions and the language features of this one. Background work
 * (workspace indexing, project scans) must hand control back regularly.
 */
export function yieldToEventLoop(): Promise<void> {
	return new Promise<void>((resolve) => {
		if (typeof setImmediate === "function") setImmediate(resolve);
		else setTimeout(resolve, 0);
	});
}

export interface TimeBudgetOptions {
	/** Maximum synchronous work (ms) before the loop yields. */
	budgetMs?: number;
	/** Cooperative cancellation checked between items. */
	isCancelled?: () => boolean;
}

/**
 * Runs `items` through `work` while yielding whenever the synchronous budget is
 * exhausted. Total runtime is unchanged, but the event loop keeps turning, so
 * the extension host stays responsive and cancellation is honoured promptly.
 */
export async function forEachWithTimeBudget<T>(
	items: readonly T[],
	work: (item: T, index: number) => void | Promise<void>,
	options: TimeBudgetOptions = {},
): Promise<number> {
	const budget = options.budgetMs ?? 8;
	let processed = 0;
	let sliceStart = performance.now();
	for (const item of items) {
		if (options.isCancelled?.()) break;
		await work(item, processed);
		processed++;
		if (performance.now() - sliceStart < budget) continue;
		await yieldToEventLoop();
		if (options.isCancelled?.()) break;
		sliceStart = performance.now();
	}
	return processed;
}

/**
 * Resolves with `undefined` when `promise` does not settle within `timeoutMs`.
 *
 * Requests to an external process (the Godot language server, a debug adapter)
 * can stay unanswered forever if that process is wedged; callers must never
 * wait on them without a bound.
 */
export function withTimeout<T>(promise: Promise<T>, timeoutMs: number, onTimeout?: () => void): Promise<T | undefined> {
	return new Promise<T | undefined>((resolve) => {
		let settled = false;
		const timer = setTimeout(() => {
			if (settled) return;
			settled = true;
			onTimeout?.();
			resolve(undefined);
		}, Math.max(0, timeoutMs));
		promise.then(
			(value) => {
				if (settled) return;
				settled = true;
				clearTimeout(timer);
				resolve(value);
			},
			() => {
				if (settled) return;
				settled = true;
				clearTimeout(timer);
				resolve(undefined);
			},
		);
	});
}
