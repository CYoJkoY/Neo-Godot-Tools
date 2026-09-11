import type { ResolutionConfidence, ResolutionResult } from "./query_engine";

/** Local semantic results that are safe to expose without asking Godot LSP. */
export function isSafeLocalConfidence(confidence: ResolutionConfidence): boolean {
	return confidence === "exact" || confidence === "inferred";
}

export function shouldFallback<T>(result: ResolutionResult<T>): boolean {
	return !result.value || result.confidence === "partial" || result.confidence === "unknown";
}
