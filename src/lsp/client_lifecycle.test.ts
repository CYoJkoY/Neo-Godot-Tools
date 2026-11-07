import { strict as assert } from "node:assert";
import { describe, it } from "node:test";
import { stopAfterStart } from "./client_lifecycle.js";

describe("language client lifecycle", () => {
	it("waits for startup before stopping a running client", async () => {
		let resolveStart!: () => void;
		let running = false;
		let stopCalls = 0;
		const starting = new Promise<void>((resolve) => {
			resolveStart = () => {
				running = true;
				resolve();
			};
		});

		const stopping = stopAfterStart(starting, () => running, async () => {
			stopCalls++;
			running = false;
		});
		assert.equal(stopCalls, 0);

		resolveStart();
		await stopping;

		assert.equal(stopCalls, 1);
		assert.equal(running, false);
	});

	it("does not stop when startup rejects", async () => {
		let stopCalls = 0;
		await stopAfterStart(
			Promise.reject(new Error("startup failed")),
			() => true,
			async () => {
				stopCalls++;
			},
		);
		assert.equal(stopCalls, 0);
	});

	it("does not stop an already stopped client", async () => {
		let stopCalls = 0;
		await stopAfterStart(undefined, () => false, async () => {
			stopCalls++;
		});
		assert.equal(stopCalls, 0);
	});
});
