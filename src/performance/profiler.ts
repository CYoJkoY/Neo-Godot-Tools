import { performance } from "node:perf_hooks";

export type PerformanceSample = {
	count: number;
	totalMs: number;
	maxMs: number;
	p50Ms: number;
	p95Ms: number;
	p99Ms: number;
};

export type PerformanceSnapshot = Record<string, PerformanceSample>;

const MAX_RECENT_SAMPLES = 512;

export class PerformanceProfiler {
	private readonly samples = new Map<string, PerformanceSample>();
	private readonly recent = new Map<string, number[]>();

	record(name: string, durationMs: number): void {
		const previous = this.samples.get(name) ?? { count: 0, totalMs: 0, maxMs: 0, p50Ms: 0, p95Ms: 0, p99Ms: 0 };
		const values = this.recent.get(name) ?? [];
		values.push(durationMs);
		if (values.length > MAX_RECENT_SAMPLES) values.shift();
		this.recent.set(name, values);
		this.samples.set(name, {
			count: previous.count + 1,
			totalMs: previous.totalMs + durationMs,
			maxMs: Math.max(previous.maxMs, durationMs),
			p50Ms: this.percentile(values, 0.5),
			p95Ms: this.percentile(values, 0.95),
			p99Ms: this.percentile(values, 0.99),
		});
	}

	measure<T>(name: string, operation: () => T): T {
		const start = performance.now();
		try {
			return operation();
		} finally {
			this.record(name, performance.now() - start);
		}
	}

	async measureAsync<T>(name: string, operation: () => Promise<T>): Promise<T> {
		const start = performance.now();
		try {
			return await operation();
		} finally {
			this.record(name, performance.now() - start);
		}
	}

	getSnapshot(): PerformanceSnapshot {
		return Object.fromEntries([...this.samples.entries()].map(([name, sample]) => [name, { ...sample }]));
	}

	reset(): void {
		this.samples.clear();
		this.recent.clear();
	}

	private percentile(values: readonly number[], percentile: number): number {
		if (!values.length) return 0;
		const sorted = [...values].sort((a, b) => a - b);
		const index = Math.min(sorted.length - 1, Math.ceil(percentile * sorted.length) - 1);
		return sorted[index];
	}
}

export const languageProfiler = new PerformanceProfiler();
