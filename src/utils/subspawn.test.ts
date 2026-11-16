import { strict as assert } from "node:assert";
import { describe, it } from "node:test";
import { godot_child_process_options } from "./subspawn.js";

describe("godot_child_process_options", () => {
	it("keeps owned children attached and hidden on Windows", () => {
		const options = godot_child_process_options("win32", { shell: true });

		assert.equal(options.detached, false);
		assert.equal(options.windowsHide, true);
		assert.equal(options.shell, true);
	});

	it("keeps detached process groups on POSIX for process-tree cleanup", () => {
		for (const platform of ["linux", "darwin"] as const) {
			const options = godot_child_process_options(platform);

			assert.equal(options.detached, true);
			assert.equal(options.windowsHide, undefined);
		}
	});

	it("does not mutate the caller's options", () => {
		const input = { shell: true };

		godot_child_process_options("win32", input);

		assert.deepEqual(input, { shell: true });
	});
});
