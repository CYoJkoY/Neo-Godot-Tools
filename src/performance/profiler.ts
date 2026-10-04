import { performance } from "node:perf_hooks";

export type PerformanceSample = {
	count: number;
	totalMs: number;
	maxMs: number;
	p50Ms: number;
	p95Ms: number;
	p99Ms: number;
};

/** Metrics with a dedicated call site in the language pipeline. */
export type LanguageMetric =
	| "parse"
	| "collectSymbols"
	| "scheduledUpdate"
	| "semantic.definition"
	| "semantic.references"
	| "semantic.hover"
	| "semantic.completion"
	| "semantic.signatureHelp"
	| "lsp.fallback.definition"
	| "lsp.fallback.references"
	| "lsp.fallback.rename";

/** LSP round trips are recorded per request method, hence the open suffix. */
export type PerformanceMetric = LanguageMetric | `lsp.request.${string}`;

export type PerformanceSnapshot = Partial<Record<LanguageMetric, PerformanceSample>>;

const MAX_RECENT_SAMPLES = 512;

interface RecentSamples {
	values: number[];
	next: number;
	count: number;
}

export interface PerformanceProfiler {
	record(name: PerformanceMetric, durationMs: number): void;
	measure<T>(name: PerformanceMetric, operation: () => T): T;
	measureAsync<T>(name: PerformanceMetric, operation: () => Promise<T>): Promise<T>;
	getSnapshot(): PerformanceSnapshot;
	reset(): void;
}

/** Nearest rank of an already sorted window; `0` when nothing was collected. */
const percentile = (sorted: readonly number[], fraction: number): number => {
	if (!sorted.length) return 0;
	return sorted[Math.min(sorted.length - 1, Math.ceil(fraction * sorted.length) - 1)];
};

/**
 * Low-overhead runtime measurements. Percentiles are deliberately computed
 * when a snapshot is requested, not on every parse/update: sorting a 512-item
 * history for every indexed file made the profiler itself a startup bottleneck.
 */
export function createPerformanceProfiler(): PerformanceProfiler {
	const samples = new Map<PerformanceMetric, Omit<PerformanceSample, "p50Ms" | "p95Ms" | "p99Ms">>();
	const recent = new Map<PerformanceMetric, RecentSamples>();

	const record = (name: PerformanceMetric, durationMs: number): void => {
		const previous = samples.get(name) ?? { count: 0, totalMs: 0, maxMs: 0 };
		// A fixed ring buffer: recording must not allocate per call.
		const window = recent.get(name) ?? { values: new Array<number>(MAX_RECENT_SAMPLES), next: 0, count: 0 };
		window.values[window.next] = durationMs;
		window.next = (window.next + 1) % MAX_RECENT_SAMPLES;
		window.count = Math.min(MAX_RECENT_SAMPLES, window.count + 1);
		recent.set(name, window);
		samples.set(name, {
			count: previous.count + 1,
			totalMs: previous.totalMs + durationMs,
			maxMs: Math.max(previous.maxMs, durationMs),
		});
	};

	return {
		record,
		measure: (name, operation) => {
			const start = performance.now();
			try {
				return operation();
			} finally {
				record(name, performance.now() - start);
			}
		},
		measureAsync: async (name, operation) => {
			const start = performance.now();
			try {
				return await operation();
			} finally {
				record(name, performance.now() - start);
			}
		},
		getSnapshot: () =>
			Object.fromEntries(
				[...samples].map(([name, sample]) => {
					const window = recent.get(name);
					const sorted = window ? window.values.slice(0, window.count).sort((a, b) => a - b) : [];
					return [
						name,
						{
							...sample,
							p50Ms: percentile(sorted, 0.5),
							p95Ms: percentile(sorted, 0.95),
							p99Ms: percentile(sorted, 0.99),
						},
					];
				}),
			),
		reset: () => {
			samples.clear();
			recent.clear();
		},
	};
}

export const languageProfiler = createPerformanceProfiler();
