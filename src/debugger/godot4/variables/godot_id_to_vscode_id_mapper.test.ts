import { strict as assert } from "node:assert";
import { describe, it } from "node:test";
import { GodotIdWithPath, GodotIdToVscodeIdMapper } from "./godot_id_to_vscode_id_mapper";

describe("GodotIdToVscodeIdMapper", () => {
	it("create_vscode_id assigns unique ID", () => {
		const mapper = new GodotIdToVscodeIdMapper();
		const godotId = new GodotIdWithPath(BigInt(1), ["path1"]);
		const vscodeId = mapper.create_vscode_id(godotId);
		assert.equal(vscodeId, 1);
	});

	it("create_vscode_id throws error on duplicate", () => {
		const mapper = new GodotIdToVscodeIdMapper();
		const godotId = new GodotIdWithPath(BigInt(1), ["path1"]);
		mapper.create_vscode_id(godotId);
		assert.throws(() => mapper.create_vscode_id(godotId), /Duplicate godot_id: 1:path1/);
	});

	it("get_godot_id_with_path returns correct object", () => {
		const mapper = new GodotIdToVscodeIdMapper();
		const godotId = new GodotIdWithPath(BigInt(2), ["path2"]);
		const vscodeId = mapper.create_vscode_id(godotId);
		assert.deepEqual(mapper.get_godot_id_with_path(vscodeId), godotId);
	});

	it("get_godot_id_with_path throws error if not found", () => {
		const mapper = new GodotIdToVscodeIdMapper();
		assert.throws(() => mapper.get_godot_id_with_path(999), /Unknown vscode_id: 999/);
	});

	it("get_vscode_id retrieves correct ID", () => {
		const mapper = new GodotIdToVscodeIdMapper();
		const godotId = new GodotIdWithPath(BigInt(3), ["path3"]);
		const vscodeId = mapper.create_vscode_id(godotId);
		assert.equal(mapper.get_vscode_id(godotId), vscodeId);
	});

	it("get_vscode_id throws error if not found", () => {
		const mapper = new GodotIdToVscodeIdMapper();
		const godotId = new GodotIdWithPath(BigInt(4), ["path4"]);
		assert.throws(() => mapper.get_vscode_id(godotId), /Unknown godot_id_with_path: 4:path4/);
	});

	it("get_or_create_vscode_id creates new ID if not found", () => {
		const mapper = new GodotIdToVscodeIdMapper();
		const godotId = new GodotIdWithPath(BigInt(5), ["path5"]);
		const vscodeId = mapper.get_or_create_vscode_id(godotId);
		assert.equal(vscodeId, 1);
	});

	it("get_or_create_vscode_id retrieves existing ID if already created", () => {
		const mapper = new GodotIdToVscodeIdMapper();
		const godotId = new GodotIdWithPath(BigInt(6), ["path6"]);
		const vscodeId1 = mapper.get_or_create_vscode_id(godotId);
		const vscodeId2 = mapper.get_or_create_vscode_id(godotId);
		assert.equal(vscodeId1, vscodeId2);
	});
});
