import { performance } from "node:perf_hooks";
import { setTimeout as delay } from "node:timers/promises";

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
	// `work` is awaited on every step, so this unwinds instead of growing a stack.
	const processFrom = async (from: number, sliceStart: number): Promise<number> => {
		if (from >= items.length || options.isCancelled?.()) return from;
		await work(items[from], from);
		if (performance.now() - sliceStart < budget) return processFrom(from + 1, sliceStart);
		await yieldToEventLoop();
		return processFrom(from + 1, performance.now());
	};
	return processFrom(0, performance.now());
}

/**
 * Resolves with `undefined` when `promise` does not settle within `timeoutMs`.
 *
 * Requests to an external process (the Godot language server, a debug adapter)
 * can stay unanswered forever if that process is wedged; callers must never
 * wait on them without a bound.
 */
export async function withTimeout<T>(
	promise: Promise<T>,
	timeoutMs: number,
	onTimeout?: () => void,
): Promise<T | undefined> {
	const abort = new AbortController();
	const timeout = delay(Math.max(0, timeoutMs), undefined, { signal: abort.signal });
	const expiry = timeout.then(() => {
		onTimeout?.();
		return undefined;
	});
	try {
		// Rejections are reported as a timeout-sized gap rather than thrown at the caller.
		return await Promise.race([promise.catch(() => undefined), expiry]);
	} finally {
		// Settling first cancels the pending timer so it cannot hold the event loop open.
		abort.abort();
	}
}
