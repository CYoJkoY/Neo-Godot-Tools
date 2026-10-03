import { type GodotValue, GodotVariable, is_gd_object } from "../debug_runtime";
import { SceneNode } from "../scene_tree_provider";
import { VariablesManager } from "./variables/variables_manager";
import { ObjectId } from "./variables/variants";

/** Reads a string out of the Godot 4 scene protocol array. */
function next_string(params: unknown[], ofs: { offset: number }): string {
	const value = params[ofs.offset++];
	return typeof value === "string" ? value : String(value);
}

/** Reads a number out of the Godot 4 scene protocol array. */
function next_number(params: unknown[], ofs: { offset: number }): number {
	const value = params[ofs.offset++];
	return typeof value === "number" ? value : Number(value);
}

export function parse_next_scene_node(params: unknown[], ofs: { offset: number } = { offset: 0 }): SceneNode {
	const childCount = next_number(params, ofs);
	const name = next_string(params, ofs);
	const className = next_string(params, ofs);
	const id = next_number(params, ofs);
	const sceneFilePath = next_string(params, ofs);
	const viewFlags = next_number(params, ofs);

	const children: SceneNode[] = [];
	for (let i = 0; i < childCount; ++i) {
		children.push(parse_next_scene_node(params, ofs));
	}

	return new SceneNode(name, className, id, children, sceneFilePath, viewFlags);
}

export function split_buffers(buffer: Buffer) {
	let len = buffer.byteLength;
	let offset = 0;
	const buffers: Buffer[] = [];
	while (len > 0) {
		const subLength = buffer.readUInt32LE(offset) + 4;
		buffers.push(buffer.subarray(offset, offset + subLength));
		offset += subLength;
		len -= subLength;
	}

	return buffers;
}

export async function get_sub_values(value: GodotValue, variables_manager: VariablesManager): Promise<GodotVariable[]> {
	let subValues: GodotVariable[] = [];

	if (Array.isArray(value)) {
		subValues = value.map((element, i) => ({
			id: element instanceof ObjectId ? element.id : undefined,
			name: `${i}`,
			value: element,
		}));
	} else if (value instanceof Map) {
		for (const [key, element] of value.entries()) {
			subValues.push({
				id: element instanceof ObjectId ? element.id : undefined,
				name: is_gd_object(key) ? `${key.type_name()}${key.stringify_value()}` : `${key}`,
				value: element,
			});
		}
	} else if (is_gd_object(value)) {
		subValues = value.sub_values().map((sva) => ({ name: sva.name, value: sva.value }));
	}

	for (const sub_value of subValues) {
		sub_value.sub_values = await get_sub_values(sub_value.value, variables_manager);
	}

	return subValues;
}
