import assert from "node:assert/strict";
import { parseGDScript } from "../analyzer/index.js";
import { collectControlFlowAssignments } from "./control_flow.js";

const source = `extends Node
func test(flag: bool):
\tvar value
\tif flag:
\t\tvalue = Player.new()
\telse:
\t\tvalue = Player.new()
\tvalue
`;
const parsed = parseGDScript(source);
const fn = parsed.ast.declarations.find((declaration) => declaration.kind === "function");
assert.ok(fn?.kind === "function");
assert.ok(fn.bodyRange);

const afterBranch = source.indexOf("\tvalue\n", source.indexOf("else:"));
assert.deepEqual(collectControlFlowAssignments(source, fn.bodyRange, "value", afterBranch), ["Player . new ( )", "Player . new ( )"]);

const uncertainSource = `extends Node
func test(flag: bool):
\tvar value = Resource.new()
\tif flag:
\t\tvalue = Player.new()
\tvalue
`;
const uncertainParsed = parseGDScript(uncertainSource);
const uncertainFn = uncertainParsed.ast.declarations.find((declaration) => declaration.kind === "function");
assert.ok(uncertainFn?.kind === "function");
assert.ok(uncertainFn.bodyRange);
const uncertainOffset = uncertainSource.lastIndexOf("\tvalue");
assert.deepEqual(collectControlFlowAssignments(uncertainSource, uncertainFn.bodyRange, "value", uncertainOffset), []);

console.log("control_flow tests passed");
