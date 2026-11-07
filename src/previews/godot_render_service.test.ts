import { strict as assert } from "node:assert";
import { describe, it } from "node:test";
import { createRenderError, describeRenderError } from "./godot_render_service.js";

describe("native render errors", () => {
	it("explains known failure codes with the underlying detail", () => {
		const missing = createRenderError("shader_type_missing", "shader_type_missing");
		assert.equal(describeRenderError(missing), "Add a shader_type declaration before this shader can render.");

		const sky = createRenderError("shader_type_requires_godot4", "shader_type_requires_godot4");
		assert.match(describeRenderError(sky), /Sky shaders render in Godot 4/);

		const mismatch = createRenderError("version_mismatch", "/opt/godot reports 3.7");
		assert.equal(
			describeRenderError(mismatch),
			"The configured executable is a different Godot major version than this project. (/opt/godot reports 3.7)",
		);
	});

	it("falls back to the raw message for unknown codes and plain errors", () => {
		assert.equal(
			describeRenderError(createRenderError("disposed", "The preview service is shutting down.")),
			"The preview service is shutting down.",
		);
		assert.equal(describeRenderError(new Error("spawn ENOENT")), "spawn ENOENT");
		assert.equal(describeRenderError("offline"), "offline");
		assert.equal(describeRenderError(undefined), "undefined");
	});
});
