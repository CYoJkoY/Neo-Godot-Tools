import { IndexedParameter, IndexedSymbol } from "../../index/index.js";

export interface GDScriptBuiltinFunction {
	name: string;
	parameters: IndexedParameter[];
	returnType?: string;
	description: string;
}

const GLOBAL_SCOPE_URI = "gdscript://builtin/@GlobalScope";
const GDSCRIPT_URI = "gdscript://builtin/@GDScript";

const p = (name: string, type?: string, defaultValue?: string): IndexedParameter => ({ name, type, defaultValue });

const BUILTINS: readonly GDScriptBuiltinFunction[] = [
	{ name: "abs", parameters: [p("x", "Variant")], returnType: "Variant", description: "Returns the absolute value of x." },
	{ name: "absi", parameters: [p("x", "int")], returnType: "int", description: "Returns the absolute value of an integer." },
	{ name: "absf", parameters: [p("x", "float")], returnType: "float", description: "Returns the absolute value of a floating-point value." },
	{ name: "acos", parameters: [p("x", "float")], returnType: "float", description: "Returns the arc cosine of x in radians." },
	{ name: "asin", parameters: [p("x", "float")], returnType: "float", description: "Returns the arc sine of x in radians." },
	{ name: "atan", parameters: [p("x", "float")], returnType: "float", description: "Returns the arc tangent of x in radians." },
	{ name: "atan2", parameters: [p("y", "float"), p("x", "float")], returnType: "float", description: "Returns the arc tangent of y/x while preserving the quadrant." },
	{ name: "ceil", parameters: [p("x", "float")], returnType: "int", description: "Rounds x upward to the nearest integer." },
	{ name: "clamp", parameters: [p("value", "Variant"), p("min", "Variant"), p("max", "Variant")], returnType: "Variant", description: "Clamps a value between min and max." },
	{ name: "clampf", parameters: [p("value", "float"), p("min", "float"), p("max", "float")], returnType: "float", description: "Clamps a floating-point value between min and max." },
	{ name: "clampi", parameters: [p("value", "int"), p("min", "int"), p("max", "int")], returnType: "int", description: "Clamps an integer between min and max." },
	{ name: "cos", parameters: [p("x", "float")], returnType: "float", description: "Returns the cosine of x in radians." },
	{ name: "deg_to_rad", parameters: [p("degree", "float")], returnType: "float", description: "Converts degrees to radians." },
	{ name: "floor", parameters: [p("x", "float")], returnType: "int", description: "Rounds x downward to the nearest integer." },
	{ name: "fmod", parameters: [p("x", "float"), p("y", "float")], returnType: "float", description: "Returns the floating-point remainder of x divided by y." },
	{ name: "inverse_lerp", parameters: [p("from", "float"), p("to", "float"), p("value", "float")], returnType: "float", description: "Returns the interpolation factor for value between from and to." },
	{ name: "is_equal_approx", parameters: [p("a", "float"), p("b", "float")], returnType: "bool", description: "Returns true when two floating-point values are approximately equal." },
	{ name: "is_nan", parameters: [p("x", "float")], returnType: "bool", description: "Returns true when x is NaN." },
	{ name: "is_inf", parameters: [p("x", "float")], returnType: "bool", description: "Returns true when x is infinite." },
	{ name: "is_instance_valid", parameters: [p("instance", "Variant")], returnType: "bool", description: "Returns whether an Object instance is still valid." },
	{ name: "is_instance_id_valid", parameters: [p("id", "int")], returnType: "bool", description: "Returns whether an Object instance ID is valid." },
	{ name: "is_zero_approx", parameters: [p("x", "float")], returnType: "bool", description: "Returns true when a floating-point value is approximately zero." },
	{ name: "lerp", parameters: [p("from", "Variant"), p("to", "Variant"), p("weight", "float")], returnType: "Variant", description: "Linearly interpolates between from and to." },
	{ name: "lerpf", parameters: [p("from", "float"), p("to", "float"), p("weight", "float")], returnType: "float", description: "Linearly interpolates between two floating-point values." },
	{ name: "lerp_angle", parameters: [p("from", "float"), p("to", "float"), p("weight", "float")], returnType: "float", description: "Linearly interpolates between two angles." },
	{ name: "max", parameters: [p("a", "Variant"), p("b", "Variant")], returnType: "Variant", description: "Returns the greater of two values." },
	{ name: "maxi", parameters: [p("a", "int"), p("b", "int")], returnType: "int", description: "Returns the greater of two integers." },
	{ name: "mini", parameters: [p("a", "int"), p("b", "int")], returnType: "int", description: "Returns the smaller of two integers." },
	{ name: "min", parameters: [p("a", "Variant"), p("b", "Variant")], returnType: "Variant", description: "Returns the smaller of two values." },
	{ name: "move_toward", parameters: [p("from", "float"), p("to", "float"), p("delta", "float")], returnType: "float", description: "Moves from toward to by delta without overshooting." },
	{ name: "pingpong", parameters: [p("value", "float"), p("length", "float")], returnType: "float", description: "Returns a value that ping-pongs between 0 and length." },
	{ name: "posmod", parameters: [p("x", "int"), p("y", "int")], returnType: "int", description: "Returns a positive modulo result." },
	{ name: "fposmod", parameters: [p("x", "float"), p("y", "float")], returnType: "float", description: "Returns a positive floating-point modulo result." },
	{ name: "rad_to_deg", parameters: [p("radian", "float")], returnType: "float", description: "Converts radians to degrees." },
	{ name: "randf", parameters: [], returnType: "float", description: "Returns a random floating-point value between 0 and 1." },
	{ name: "randf_range", parameters: [p("from", "float"), p("to", "float")], returnType: "float", description: "Returns a random floating-point value in the given range." },
	{ name: "randi", parameters: [], returnType: "int", description: "Returns a random unsigned integer." },
	{ name: "randi_range", parameters: [p("from", "int"), p("to", "int")], returnType: "int", description: "Returns a random integer in the inclusive range." },
	{ name: "randomize", parameters: [], returnType: "void", description: "Randomizes the global random seed." },
	{ name: "remap", parameters: [p("value", "float"), p("istart", "float"), p("istop", "float"), p("ostart", "float"), p("ostop", "float")], returnType: "float", description: "Maps a value from one range to another." },
	{ name: "snapped", parameters: [p("value", "Variant"), p("step", "Variant")], returnType: "Variant", description: "Snaps a value to a given step." },
	{ name: "snappedf", parameters: [p("value", "float"), p("step", "float")], returnType: "float", description: "Snaps a floating-point value to a given step." },
	{ name: "sqrt", parameters: [p("x", "float")], returnType: "float", description: "Returns the square root of x." },
	{ name: "tan", parameters: [p("x", "float")], returnType: "float", description: "Returns the tangent of x in radians." },
	{ name: "typeof", parameters: [p("variable", "Variant")], returnType: "int", description: "Returns the Variant type identifier of a value." },
	{ name: "type_convert", parameters: [p("variant", "Variant"), p("type", "int")], returnType: "Variant", description: "Converts a Variant to the requested Variant type." },
	{ name: "len", parameters: [p("value", "Variant")], returnType: "int", description: "Returns the length of a String, Array, Dictionary, or other supported container." },
	{ name: "int", parameters: [p("from", "Variant")], returnType: "int", description: "Converts a value to an integer." },
	{ name: "float", parameters: [p("from", "Variant")], returnType: "float", description: "Converts a value to a floating-point number." },
	{ name: "bool", parameters: [p("from", "Variant")], returnType: "bool", description: "Converts a value to a boolean." },
	{ name: "str", parameters: [p("what", "Variant")], returnType: "String", description: "Converts a value to its string representation." },
	{ name: "ord", parameters: [p("char", "String")], returnType: "int", description: "Returns the Unicode code point of a character." },
	{ name: "char", parameters: [p("code", "int")], returnType: "String", description: "Returns the character represented by a Unicode code point." },
	{ name: "str_to_var", parameters: [p("string", "String")], returnType: "Variant", description: "Decodes a Variant from its string representation." },
	{ name: "var_to_str", parameters: [p("variable", "Variant")], returnType: "String", description: "Encodes a Variant as a string." },
	{ name: "print", parameters: [p("what", "Variant")], returnType: "void", description: "Prints one or more values to the output console." },
	{ name: "print_debug", parameters: [p("what", "Variant")], returnType: "void", description: "Prints values with the current script location." },
	{ name: "printerr", parameters: [p("what", "Variant")], returnType: "void", description: "Prints values to the standard error stream." },
	{ name: "print_rich", parameters: [p("what", "String")], returnType: "void", description: "Prints text with BBCode formatting." },
	{ name: "prints", parameters: [p("what", "Variant")], returnType: "void", description: "Prints values separated by spaces." },
	{ name: "printt", parameters: [p("what", "Variant")], returnType: "void", description: "Prints values separated by tabs." },
	{ name: "push_error", parameters: [p("message", "String")], returnType: "void", description: "Pushes an error message to the debugger." },
	{ name: "push_warning", parameters: [p("message", "String")], returnType: "void", description: "Pushes a warning message to the debugger." },
	{ name: "error_string", parameters: [p("error", "int")], returnType: "String", description: "Returns a human-readable string for an error code." },
	{ name: "load", parameters: [p("path", "String")], returnType: "Resource", description: "Loads a resource from a resource path." },
	{ name: "preload", parameters: [p("path", "String")], returnType: "Resource", description: "Loads a resource at compile time." },
	{ name: "assert", parameters: [p("condition", "bool"), p("message", "String", "\"\"")], returnType: "void", description: "Raises an error when condition is false." },
	{ name: "is_same", parameters: [p("a", "Variant"), p("b", "Variant")], returnType: "bool", description: "Returns whether two Variant values refer to the same object." },
	{ name: "weakref", parameters: [p("obj", "Object")], returnType: "WeakRef", description: "Creates a weak reference to an object." },
	{ name: "range", parameters: [p("from", "int"), p("to", "int"), p("step", "int")], returnType: "Array", description: "Returns an array containing a sequence of integers." },
	{ name: "type_exists", parameters: [p("type", "StringName")], returnType: "bool", description: "Returns whether an Object-derived class exists in ClassDB." },
	{ name: "get_stack", parameters: [], returnType: "Array", description: "Returns the current GDScript call stack." },
	{ name: "print_stack", parameters: [], returnType: "void", description: "Prints the current GDScript call stack." },
	{ name: "convert", parameters: [p("what", "Variant"), p("type", "int")], returnType: "Variant", description: "Converts a value to the requested Variant type." },
	{ name: "is_instance_of", parameters: [p("value", "Variant"), p("type", "Variant")], returnType: "bool", description: "Returns whether a value is an instance of the given type." },
	{ name: "dict_to_inst", parameters: [p("dictionary", "Dictionary")], returnType: "Object", description: "Creates an Object instance from a dictionary." },
	{ name: "inst_to_dict", parameters: [p("instance", "Object")], returnType: "Dictionary", description: "Converts an Object instance to a dictionary." },
];

const GDSCRIPT_ONLY = new Set([
	"assert", "char", "convert", "dict_to_inst", "get_stack", "inst_to_dict", "is_instance_of", "len", "load", "ord",
	"preload", "print_debug", "print_stack", "range", "type_exists",
]);

const BY_NAME = new Map(BUILTINS.map((builtin) => [builtin.name, builtin]));

export function getGDScriptBuiltin(name: string): GDScriptBuiltinFunction | undefined {
	return BY_NAME.get(name);
}

export function getGDScriptBuiltinDocumentationClass(name: string): "@GlobalScope" | "@GDScript" {
	return GDSCRIPT_ONLY.has(name) ? "@GDScript" : "@GlobalScope";
}

export function getGDScriptBuiltins(prefix = ""): readonly GDScriptBuiltinFunction[] {
	return BUILTINS.filter((builtin) => builtin.name.startsWith(prefix));
}

export function builtinToSymbol(builtin: GDScriptBuiltinFunction): IndexedSymbol {
	const documentationClass = getGDScriptBuiltinDocumentationClass(builtin.name);
	const uri = documentationClass === "@GDScript" ? GDSCRIPT_URI : GLOBAL_SCOPE_URI;
	return {
		name: builtin.name,
		kind: "function",
		uri: `${uri}/${builtin.name}`,
		range: {
			start: { line: 0, character: 0, offset: 0 },
			end: { line: 0, character: builtin.name.length, offset: builtin.name.length },
		},
		returnType: builtin.returnType,
		parameters: builtin.parameters,
	};
}

export function isGDScriptBuiltinUri(uri: string): boolean {
	return uri.startsWith(`${GLOBAL_SCOPE_URI}/`) || uri.startsWith(`${GDSCRIPT_URI}/`);
}
