import type { GodotValue } from "../../debug_runtime";
import {
	AABB,
	Basis,
	BufferModel,
	Color,
	GDScriptTypes,
	Plane,
	Quat,
	Rect2,
	Transform,
	Transform2D,
	Vector2,
	Vector3,
	to_wire_value,
} from "./variants";

export class VariantEncoder {
	public encode_variant(raw_value: GodotValue, model?: BufferModel) {
		const value = to_wire_value(raw_value);
		const target = model ?? this.open_buffer(value);

		switch (typeof value) {
			case "number":
				{
					const is_integer = Number.isInteger(value);
					if (is_integer) {
						this.encode_UInt32(GDScriptTypes.INT, target);
						this.encode_UInt32(value, target);
					} else {
						this.encode_UInt32(GDScriptTypes.REAL | (1 << 16), target);
						this.encode_Float(value, target);
					}
				}
				break;
			case "bigint":
				this.encode_UInt32(GDScriptTypes.INT | (1 << 16), target);
				this.encode_UInt64(value, target);
				break;
			case "boolean":
				this.encode_UInt32(GDScriptTypes.BOOL, target);
				this.encode_Bool(value, target);
				break;
			case "string":
				this.encode_UInt32(GDScriptTypes.STRING, target);
				this.encode_String(value, target);
				break;
			case "undefined":
				break;
			default:
				if (Array.isArray(value)) {
					this.encode_UInt32(GDScriptTypes.ARRAY, target);
					this.encode_Array(value, target);
				} else if (value instanceof Map) {
					this.encode_UInt32(GDScriptTypes.DICTIONARY, target);
					this.encode_Dictionary(value, target);
				} else {
					if (value instanceof Vector2) {
						this.encode_UInt32(GDScriptTypes.VECTOR2, target);
						this.encode_Vector2(value, target);
					} else if (value instanceof Rect2) {
						this.encode_UInt32(GDScriptTypes.RECT2, target);
						this.encode_Rect2(value, target);
					} else if (value instanceof Vector3) {
						this.encode_UInt32(GDScriptTypes.VECTOR3, target);
						this.encode_Vector3(value, target);
					} else if (value instanceof Transform2D) {
						this.encode_UInt32(GDScriptTypes.TRANSFORM2D, target);
						this.encode_Transform2D(value, target);
					} else if (value instanceof Plane) {
						this.encode_UInt32(GDScriptTypes.PLANE, target);
						this.encode_Plane(value, target);
					} else if (value instanceof Quat) {
						this.encode_UInt32(GDScriptTypes.QUAT, target);
						this.encode_Quat(value, target);
					} else if (value instanceof AABB) {
						this.encode_UInt32(GDScriptTypes.AABB, target);
						this.encode_AABB(value, target);
					} else if (value instanceof Basis) {
						this.encode_UInt32(GDScriptTypes.BASIS, target);
						this.encode_Basis(value, target);
					} else if (value instanceof Transform) {
						this.encode_UInt32(GDScriptTypes.TRANSFORM, target);
						this.encode_Transform(value, target);
					} else if (value instanceof Color) {
						this.encode_UInt32(GDScriptTypes.COLOR, target);
						this.encode_Color(value, target);
					}
				}
		}

		return target.buffer;
	}

	private encode_AABB(value: AABB, model: BufferModel) {
		this.encode_Vector3(value.position, model);
		this.encode_Vector3(value.size, model);
	}

	private encode_Array(arr: GodotValue[], model: BufferModel) {
		const size = arr.length;
		this.encode_UInt32(size, model);
		// biome-ignore lint/complexity/noForEach: <explanation>
		arr.forEach((e) => {
			this.encode_variant(e, model);
		});
	}

	private encode_Basis(value: Basis, model: BufferModel) {
		this.encode_Vector3(value.x, model);
		this.encode_Vector3(value.y, model);
		this.encode_Vector3(value.z, model);
	}

	private encode_Bool(bool: boolean, model: BufferModel) {
		this.encode_UInt32(bool ? 1 : 0, model);
	}

	private encode_Color(value: Color, model: BufferModel) {
		this.encode_Float(value.r, model);
		this.encode_Float(value.g, model);
		this.encode_Float(value.b, model);
		this.encode_Float(value.a, model);
	}

	private encode_Dictionary(dict: Map<GodotValue, GodotValue>, model: BufferModel) {
		const size = dict.size;
		this.encode_UInt32(size, model);
		const keys = Array.from(dict.keys());
		// biome-ignore lint/complexity/noForEach: <explanation>
		keys.forEach((key) => {
			const value = dict.get(key);
			this.encode_variant(key, model);
			this.encode_variant(value, model);
		});
	}

	private encode_Float(value: number, model: BufferModel) {
		model.buffer.writeFloatLE(value, model.offset);
		model.offset += 4;
	}

	private encode_Plane(value: Plane, model: BufferModel) {
		this.encode_Float(value.x, model);
		this.encode_Float(value.y, model);
		this.encode_Float(value.z, model);
		this.encode_Float(value.d, model);
	}

	private encode_Quat(value: Quat, model: BufferModel) {
		this.encode_Float(value.x, model);
		this.encode_Float(value.y, model);
		this.encode_Float(value.z, model);
		this.encode_Float(value.w, model);
	}

	private encode_Rect2(value: Rect2, model: BufferModel) {
		this.encode_Vector2(value.position, model);
		this.encode_Vector2(value.size, model);
	}

	private encode_String(str: string, model: BufferModel) {
		let str_len = str.length;
		this.encode_UInt32(str_len, model);
		model.buffer.write(str, model.offset, str_len, "utf8");
		model.offset += str_len;
		str_len += 4;
		while (str_len % 4) {
			str_len++;
			model.buffer.writeUInt8(0, model.offset);
			model.offset++;
		}
	}

	private encode_Transform(value: Transform, model: BufferModel) {
		this.encode_Basis(value.basis, model);
		this.encode_Vector3(value.origin, model);
	}

	private encode_Transform2D(value: Transform2D, model: BufferModel) {
		this.encode_Vector2(value.origin, model);
		this.encode_Vector2(value.x, model);
		this.encode_Vector2(value.y, model);
	}

	private encode_UInt32(int: number, model: BufferModel) {
		model.buffer.writeUInt32LE(int, model.offset);
		model.offset += 4;
	}

	private encode_UInt64(value: bigint, model: BufferModel) {
		model.buffer.writeBigUInt64LE(value, model.offset);
		model.offset += 8;
	}

	private encode_Vector2(value: Vector2, model: BufferModel) {
		this.encode_Float(value.x, model);
		this.encode_Float(value.y, model);
	}

	private encode_Vector3(value: Vector3, model: BufferModel) {
		this.encode_Float(value.x, model);
		this.encode_Float(value.y, model);
		this.encode_Float(value.z, model);
	}

	private size_Bool(): number {
		return this.size_UInt32();
	}

	private size_Dictionary(dict: Map<GodotValue, GodotValue>): number {
		let size = this.size_UInt32();
		const keys = Array.from(dict.keys());
		// biome-ignore lint/complexity/noForEach: <explanation>
		keys.forEach((key) => {
			const value = dict.get(key);
			size += this.size_variant(key);
			size += this.size_variant(value);
		});

		return size;
	}

	private size_String(str: string): number {
		let size = this.size_UInt32() + str.length;
		while (size % 4) {
			size++;
		}
		return size;
	}

	private size_UInt32(): number {
		return 4;
	}

	private size_UInt64(): number {
		return 8;
	}

	private size_array(arr: GodotValue[]): number {
		let size = this.size_UInt32();
		// biome-ignore lint/complexity/noForEach: <explanation>
		arr.forEach((e) => {
			size += this.size_variant(e);
		});

		return size;
	}

	/** Builds the buffer a top-level variant is written into, including its size prefix. */
	private open_buffer(value: GodotValue): BufferModel {
		const size = this.size_variant(value);
		const model: BufferModel = { buffer: Buffer.alloc(size + 4), offset: 0, len: 0 };
		this.encode_UInt32(size, model);
		return model;
	}

	private size_variant(raw_value: GodotValue): number {
		const value = to_wire_value(raw_value);
		let size = 4;

		switch (typeof value) {
			case "number":
				size += this.size_UInt32();
				break;
			case "bigint":
				size += this.size_UInt64();
				break;
			case "boolean":
				size += this.size_Bool();
				break;
			case "string":
				size += this.size_String(value);
				break;
			case "undefined":
				break;
			default:
				if (Array.isArray(value)) {
					size += this.size_array(value);
					break;
				} else if (value instanceof Map) {
					size += this.size_Dictionary(value);
					break;
				} else {
					// Non-native variants arrive as tagged objects
					// (`{ __type__: "Vector2", x, y }`); the tag picks the wire layout.
					switch (
						typeof value === "object" && value !== null && "__type__" in value
							? value["__type__"]
							: undefined
					) {
						case "Vector2":
							size += this.size_UInt32() * 2;
							break;
						case "Rect2":
							size += this.size_UInt32() * 4;
							break;
						case "Vector3":
							size += this.size_UInt32() * 3;
							break;
						case "Transform2D":
							size += this.size_UInt32() * 6;
							break;
						case "Plane":
							size += this.size_UInt32() * 4;
							break;
						case "Quat":
							size += this.size_UInt32() * 4;
							break;
						case "AABB":
							size += this.size_UInt32() * 6;
							break;
						case "Basis":
							size += this.size_UInt32() * 9;
							break;
						case "Transform":
							size += this.size_UInt32() * 12;
							break;
						case "Color":
							size += this.size_UInt32() * 4;
							break;
					}
				}
		}

		return size;
	}
}
