import assert from "node:assert/strict";
import { isSafeLocalConfidence, shouldFallback } from "./resolution_policy.js";

assert.equal(isSafeLocalConfidence("exact"), true);
assert.equal(isSafeLocalConfidence("inferred"), true);
assert.equal(isSafeLocalConfidence("partial"), false);
assert.equal(isSafeLocalConfidence("unknown"), false);
assert.equal(shouldFallback({ value: 1, confidence: "exact" }), false);
assert.equal(shouldFallback({ value: 1, confidence: "inferred" }), false);
assert.equal(shouldFallback({ value: 1, confidence: "partial" }), true);
assert.equal(shouldFallback({ confidence: "unknown" }), true);

console.log("resolution policy tests passed");
