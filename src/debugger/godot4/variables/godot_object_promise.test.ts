import { strict as assert } from "node:assert";
import { afterEach, beforeEach, describe, it } from "node:test";
import sinon from "sinon";
import { GodotObject, GodotObjectPromise } from "./godot_object_promise";

describe("GodotObjectPromise", () => {
	let clock: sinon.SinonFakeTimers;

	beforeEach(() => {
		clock = sinon.useFakeTimers(); // Use Sinon to control time
	});

	afterEach(() => {
		clock.restore(); // Restore the real timers after each test
	});

	it("resolves successfully with a valid GodotObject", async () => {
		const godotObject: GodotObject = {
			godot_id: BigInt(1),
			type: "TestType",
			sub_values: [],
		};

		const promise = new GodotObjectPromise();
		setTimeout(() => promise.resolve(godotObject), 10);
		clock.tick(10); // Fast-forward time
		await promise.promise;
		assert.equal(promise.promise instanceof Promise, true);
		assert.deepEqual(await promise.promise, godotObject);
	});

	it("rejects with an error when explicitly called", async () => {
		const promise = new GodotObjectPromise();
		const error = new Error("Test rejection");
		setTimeout(() => promise.reject(error), 10);
		clock.tick(10); // Fast-forward time
		await assert.rejects(promise.promise, /Test rejection/);
	});

	it("rejects due to timeout", async () => {
		const promise = new GodotObjectPromise(50);
		clock.tick(50); // Fast-forward time
		await assert.rejects(promise.promise, /GodotObjectPromise timed out/);
	});

	it("does not reject if resolved before timeout", async () => {
		const godotObject: GodotObject = {
			godot_id: BigInt(2),
			type: "AnotherTestType",
			sub_values: [],
		};

		const promise = new GodotObjectPromise(100);
		setTimeout(() => promise.resolve(godotObject), 10);
		clock.tick(10); // Fast-forward time
		assert.deepEqual(await promise.promise, godotObject);
	});

	it("clears timeout when resolved", async () => {
		const promise = new GodotObjectPromise(1000);
		promise.resolve({ godot_id: BigInt(3), type: "ResolvedType", sub_values: [] });
		clock.tick(1000); // Fast-forward time
		await promise.promise;
	});

	it("clears timeout when rejected", async () => {
		const promise = new GodotObjectPromise(1000);
		promise.reject(new Error("Rejected"));
		clock.tick(1000); // Fast-forward time
		await assert.rejects(promise.promise, /Rejected/);
	});
});
