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

/**
 * Low-overhead runtime measurements. Percentiles are deliberately computed
 * when a snapshot is requested, not on every parse/update: sorting a 512-item
 * history for every indexed file made the profiler itself a startup bottleneck.
 */
export class PerformanceProfiler {
	private readonly samples = new Map<PerformanceMetric, Omit<PerformanceSample, "p50Ms" | "p95Ms" | "p99Ms">>();
	private readonly recent = new Map<PerformanceMetric, RecentSamples>();

	record(name: PerformanceMetric, durationMs: number): void {
		const previous = this.samples.get(name) ?? { count: 0, totalMs: 0, maxMs: 0 };
		let recent = this.recent.get(name);
		if (!recent) {
			recent = { values: new Array<number>(MAX_RECENT_SAMPLES), next: 0, count: 0 };
			this.recent.set(name, recent);
		}
		recent.values[recent.next] = durationMs;
		recent.next = (recent.next + 1) % MAX_RECENT_SAMPLES;
		recent.count = Math.min(MAX_RECENT_SAMPLES, recent.count + 1);
		this.samples.set(name, {
			count: previous.count + 1,
			totalMs: previous.totalMs + durationMs,
			maxMs: Math.max(previous.maxMs, durationMs),
		});
	}

	measure<T>(name: PerformanceMetric, operation: () => T): T {
		const start = performance.now();
		try {
			return operation();
		} finally {
			this.record(name, performance.now() - start);
		}
	}

	async measureAsync<T>(name: PerformanceMetric, operation: () => Promise<T>): Promise<T> {
		const start = performance.now();
		try {
			return await operation();
		} finally {
			this.record(name, performance.now() - start);
		}
	}

	getSnapshot(): PerformanceSnapshot {
		const snapshot: Record<string, PerformanceSample> = {};
		for (const [name, sample] of this.samples) {
			const recent = this.recent.get(name);
			const values = recent ? recent.values.slice(0, recent.count).sort((a, b) => a - b) : [];
			snapshot[name] = {
				...sample,
				p50Ms: this.percentile(values, 0.5),
				p95Ms: this.percentile(values, 0.95),
				p99Ms: this.percentile(values, 0.99),
			};
		}
		return snapshot;
	}

	reset(): void {
		this.samples.clear();
		this.recent.clear();
	}

	private percentile(values: readonly number[], percentile: number): number {
		if (!values.length) return 0;
		const index = Math.min(values.length - 1, Math.ceil(percentile * values.length) - 1);
		return values[index];
	}
}

export const languageProfiler = new PerformanceProfiler();
