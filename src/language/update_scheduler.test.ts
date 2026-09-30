import { strict as assert } from "node:assert";
import { describe, it } from "node:test";
import { ScheduledUpdate, UpdateScheduler } from "./update_scheduler";

describe("UpdateScheduler", () => {
	it("coalesces multiple updates for the same URI", async () => {
		const applied: ScheduledUpdate[] = [];
		const scheduler = new UpdateScheduler(1000, (update) => {
			applied.push(update);
		});

		scheduler.enqueue({ uri: "file:///player.gd", version: 1, source: "var hp = 1" });
		scheduler.enqueue({ uri: "file:///player.gd", version: 2, source: "var hp = 2" });
		await scheduler.flush();

		assert.equal((applied).length, 1);
		assert.equal(applied[0].version, 2);
		assert.equal(applied[0].source, "var hp = 2");
		scheduler.dispose();
	});

	it("invalidates an in-flight filesystem update when a newer update arrives", async () => {
		let resolveApply: (() => void) | undefined;
		let first: ScheduledUpdate | undefined;
		const scheduler = new UpdateScheduler(1000, async (update) => {
			// Only the first update is held in-flight; later updates are applied
			// immediately so the flush can drain the queue.
			if (first) return;
			first = update;
			await new Promise<void>((resolve) => {
				resolveApply = resolve;
			});
		});

		scheduler.enqueue({ uri: "file:///player.gd", version: 1 });
		const flush = scheduler.flush();
		await Promise.resolve();
		scheduler.enqueue({ uri: "file:///player.gd", version: 2, source: "var hp = 2" });
		assert.ok(first);
		assert.equal(scheduler.isCurrent(first!), false);
		resolveApply!();
		await flush;
		scheduler.dispose();
	});

	it("drops duplicate filesystem events after an update is applied", async () => {
		let applied = 0;
		const scheduler = new UpdateScheduler(0, () => { applied++; });

		scheduler.enqueue({ uri: "file:///player.gd", version: 0 });
		await scheduler.waitForIdle();
		scheduler.enqueue({ uri: "file:///player.gd", version: 0 });
		scheduler.enqueue({ uri: "file:///player.gd", version: 0 });
		await scheduler.waitForIdle();

		assert.equal(applied, 1);
		scheduler.dispose();
	});
});
