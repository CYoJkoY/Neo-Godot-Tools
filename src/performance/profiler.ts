import { performance } from "node:perf_hooks";

export type PerformanceSample = {
	count: number;
	totalMs: number;
	maxMs: number;
};

export type PerformanceSnapshot = Record<string, PerformanceSample>;

export class PerformanceProfiler {
	private readonly samples = new Map<string, PerformanceSample>();

	record(name: string, durationMs: number): void {
		const previous = this.samples.get(name) ?? { count: 0, totalMs: 0, maxMs: 0 };
		this.samples.set(name, {
			count: previous.count + 1,
			totalMs: previous.totalMs + durationMs,
			maxMs: Math.max(previous.maxMs, durationMs),
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

	getSnapshot(): PerformanceSnapshot {
		return Object.fromEntries([...this.samples.entries()].map(([name, sample]) => [name, { ...sample }]));
	}

	reset(): void {
		this.samples.clear();
	}
}

export const languageProfiler = new PerformanceProfiler();
