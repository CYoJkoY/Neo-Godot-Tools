import { performance } from "node:perf_hooks";
import { languageProfiler } from "../performance/profiler.js";

export type ScheduledUpdate = {
	uri: string;
	version: number;
	source?: string;
	sequence: number;
};

type PendingUpdate = ScheduledUpdate;

export class UpdateScheduler {
	private readonly pending = new Map<string, PendingUpdate>();
	private readonly latestSequence = new Map<string, number>();
	private readonly latestVersion = new Map<string, number>();
	/** Sequence of the last update applied for each uri. */
	private readonly appliedSequence = new Map<string, number>();
	private waiters: Array<{ uri: string; sequence: number; resolve: () => void }> = [];
	private timer: ReturnType<typeof setTimeout> | undefined;
	private flushing = false;
	private disposed = false;
	private idleResolvers: Array<() => void> = [];
	private sequence = 0;

	constructor(
		private readonly delayMs: number,
		private readonly apply: (update: ScheduledUpdate) => void | Promise<void>,
	) {}

	/**
	 * Queues `update` and returns its sequence, or `undefined` when the queue
	 * drops it as already applied.
	 */
	enqueue(update: Omit<ScheduledUpdate, "sequence">): number | undefined {
		if (this.disposed) return undefined;
		const previous = this.pending.get(update.uri);
		if (previous && previous.version > update.version) return previous.sequence;
		if (!previous && this.latestVersion.get(update.uri) === update.version && update.source === undefined)
			return undefined;
		const sequence = ++this.sequence;
		this.latestSequence.set(update.uri, sequence);
		this.pending.set(update.uri, { ...update, sequence });
		this.schedule();
		return sequence;
	}

	/**
	 * Resolves once the update with `sequence` (or a newer one for the same uri)
	 * has been applied. Waiting on one document keeps a request from being held
	 * up by updates queued for other files.
	 */
	whenApplied(uri: string, sequence: number): Promise<void> {
		if (this.disposed) return Promise.resolve();
		if ((this.appliedSequence.get(uri) ?? 0) >= sequence) return Promise.resolve();
		return new Promise((resolve) => this.waiters.push({ uri, sequence, resolve }));
	}

	cancel(uri: string): void {
		this.pending.delete(uri);
		this.latestVersion.delete(uri);
		this.latestSequence.set(uri, ++this.sequence);
		this.releaseWaiters(uri, true);
		this.resolveIdleIfReady();
	}

	isCurrent(update: ScheduledUpdate): boolean {
		return !this.disposed && this.latestSequence.get(update.uri) === update.sequence;
	}

	async flush(): Promise<void> {
		if (this.disposed || this.flushing) return;
		if (this.timer !== undefined) {
			clearTimeout(this.timer);
			this.timer = undefined;
		}
		this.flushing = true;
		try {
			while (this.pending.size) {
				const updates = [...this.pending.values()];
				this.pending.clear();
				for (const update of updates) {
					if (!this.isCurrent(update)) continue;
					const start = performance.now();
					try {
						await this.apply(update);
					} finally {
						languageProfiler.record("scheduledUpdate", performance.now() - start);
						// A newer edit may have superseded this one while it ran; the index
						// still moved forward, so waiters are released either way and the
						// queued successor applies next. Releasing here also means a failed
						// update cannot leave a provider awaiting this document forever.
						this.latestVersion.set(update.uri, update.version);
						this.appliedSequence.set(update.uri, update.sequence);
						this.releaseWaiters(update.uri, false);
					}
				}
			}
		} finally {
			this.flushing = false;
			this.resolveIdleIfReady();
			if (this.pending.size) this.schedule();
		}
	}

	waitForIdle(): Promise<void> {
		if (!this.pending.size && !this.flushing && this.timer === undefined) return Promise.resolve();
		return new Promise((resolve) => this.idleResolvers.push(resolve));
	}

	dispose(): void {
		this.disposed = true;
		if (this.timer !== undefined) clearTimeout(this.timer);
		this.timer = undefined;
		this.pending.clear();
		this.waiters.map((waiter) => waiter.resolve());
		this.waiters = [];
		this.resolveIdleIfReady();
	}

	private schedule(): void {
		if (this.timer !== undefined || this.disposed) return;
		this.timer = setTimeout(() => {
			this.timer = undefined;
			void this.flush();
		}, this.delayMs);
	}

	private resolveIdleIfReady(): void {
		if (this.pending.size || this.flushing || this.timer !== undefined) return;
		const resolvers = this.idleResolvers.splice(0);
		for (const resolve of resolvers) resolve();
	}

	/** Resolves waiters of `uri` whose update has been applied, or all of them. */
	private releaseWaiters(uri: string, all: boolean): void {
		const applied = this.appliedSequence.get(uri) ?? 0;
		const ready = this.waiters.filter((waiter) => waiter.uri === uri && (all || waiter.sequence <= applied));
		this.waiters = this.waiters.filter((waiter) => !ready.includes(waiter));
		ready.map((waiter) => waiter.resolve());
	}
}
