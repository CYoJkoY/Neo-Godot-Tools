import type { GodotVariable } from "../debug_runtime";
import { is_gd_object } from "../debug_runtime";
import { SceneNode } from "../scene_tree_provider";

/** Reads a string out of the Godot 3 scene protocol array. */
function next_string(params: unknown[], ofs: { offset: number }): string {
	const value = params[ofs.offset++];
	return typeof value === "string" ? value : String(value);
}

/** Reads a number out of the Godot 3 scene protocol array. */
function next_number(params: unknown[], ofs: { offset: number }): number {
	const value = params[ofs.offset++];
	return typeof value === "number" ? value : Number(value);
}

export function parse_next_scene_node(params: unknown[], ofs: { offset: number } = { offset: 0 }): SceneNode {
	const childCount = next_number(params, ofs);
	const name = next_string(params, ofs);
	const className = next_string(params, ofs);
	const id = next_number(params, ofs);

	const children: SceneNode[] = [];
	for (let i = 0; i < childCount; ++i) {
		children.push(parse_next_scene_node(params, ofs));
	}

	return new SceneNode(name, className, id, children);
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

export function is_variable_built_in_type(va: GodotVariable) {
	const type = typeof va.value;
	return ["number", "bigint", "boolean", "string"].some((x) => x === type);
}

export function build_sub_values(va: GodotVariable) {
	const value = va.value;

	let subValues: GodotVariable[] | undefined = undefined;

	if (Array.isArray(value)) {
		subValues = value.map((element, i) => ({ name: `${i}`, value: element }));
	} else if (value instanceof Map) {
		subValues = Array.from(value.keys()).map((key) => ({
			name: is_gd_object(key) ? `${key.type_name()}${key.stringify_value()}` : `${key}`,
			value: value.get(key),
		}));
	} else if (is_gd_object(value)) {
		subValues = value.sub_values().map((sva) => ({ name: sva.name, value: sva.value }));
	}

	va.sub_values = subValues;

	subValues?.forEach(build_sub_values);
}

export function parse_variable(va: GodotVariable, i?: number) {
	const value = va.value;
	let rendered_value = "";
	let reference = 0;
	let array_size = 0;
	let array_type: "indexed" | "named" | undefined = undefined;

	if (typeof value === "number") {
		if (Number.isInteger(value)) {
			rendered_value = `${value}`;
		} else {
			rendered_value = `${Number.parseFloat(value.toFixed(5))}`;
		}
	} else if (typeof value === "bigint" || typeof value === "boolean" || typeof value === "string") {
		rendered_value = `${value}`;
	} else if (typeof value === "undefined") {
		rendered_value = "null";
	} else {
		if (Array.isArray(value)) {
			rendered_value = `Array[${value.length}]`;
			array_size = value.length;
			array_type = "indexed";
			reference = i ? i : 0;
		} else if (value instanceof Map) {
			const class_name = value.get("class_name");
			rendered_value = typeof class_name === "string" ? class_name : `Dictionary[${value.size}]`;
			array_size = value.size;
			array_type = "named";
			reference = i ? i : 0;
		} else if (is_gd_object(value)) {
			rendered_value = `${value.type_name()}${value.stringify_value()}`;
			reference = i ? i : 0;
		}
	}

	return {
		name: va.name,
		value: rendered_value,
		variablesReference: reference,
		array_size: array_size > 0 ? array_size : undefined,
		filter: array_type,
	};
}
