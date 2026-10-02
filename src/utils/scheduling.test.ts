import { strict as assert } from "node:assert";
import { describe, it } from "node:test";
import { forEachWithTimeBudget, withTimeout } from "./scheduling.js";

describe("event loop scheduling", () => {
	it("resolves undefined when a promise never settles", async () => {
		const never = new Promise<string>(() => {});
		let timedOut = false;
		const start = Date.now();
		const result = await withTimeout(never, 25, () => {
			timedOut = true;
		});
		assert.equal(result, undefined);
		assert.equal(timedOut, true);
		assert.ok(Date.now() - start < 1_000);
	});

	it("passes through settled values and rejections", async () => {
		assert.equal(await withTimeout(Promise.resolve("ok"), 50), "ok");
		assert.equal(await withTimeout(Promise.reject(new Error("boom")), 50), undefined);
	});

	it("keeps the event loop turning while processing a long list", async () => {
		const items = Array.from({ length: 40 }, (_, index) => index);
		let ticks = 0;
		const timer = setInterval(() => ticks++, 1);
		const started = Date.now();
		try {
			await forEachWithTimeBudget(
				items,
				() => {
					// ~8ms of synchronous work per item: without yielding this blocks
					// the whole loop for >300ms.
					const deadline = Date.now() + 8;
					while (Date.now() < deadline) {
						/* busy wait, like real parsing work */
					}
				},
				{ budgetMs: 8 },
			);
		} finally {
			clearInterval(timer);
		}
		assert.ok(Date.now() - started > 100, "the work itself must be slow enough to observe");
		assert.ok(ticks > 5, `expected the loop to keep ticking, saw ${ticks} ticks`);
	});

	it("stops early when cancelled", async () => {
		let processed = 0;
		const cancelled = { value: false };
		await forEachWithTimeBudget(
			[1, 2, 3, 4, 5, 6, 7, 8],
			() => {
				processed++;
				if (processed === 2) cancelled.value = true;
			},
			{ budgetMs: 0, isCancelled: () => cancelled.value },
		);
		assert.equal(processed, 2);
	});
});
