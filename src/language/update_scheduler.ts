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
	private timer: ReturnType<typeof setTimeout> | undefined;
	private flushing = false;
	private disposed = false;
	private idleResolvers: Array<() => void> = [];
	private sequence = 0;

	constructor(
		private readonly delayMs: number,
		private readonly apply: (update: ScheduledUpdate) => void | Promise<void>,
	) {}

	enqueue(update: Omit<ScheduledUpdate, "sequence">): void {
		if (this.disposed) return;
		const sequence = ++this.sequence;
		this.latestSequence.set(update.uri, sequence);
		const previous = this.pending.get(update.uri);
		if (previous && previous.version > update.version) return;
		this.pending.set(update.uri, { ...update, sequence });
		this.schedule();
	}

	cancel(uri: string): void {
		this.pending.delete(uri);
		this.latestSequence.set(uri, ++this.sequence);
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
					await this.apply(update);
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
}
