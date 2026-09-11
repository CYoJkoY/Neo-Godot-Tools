import type { DependencyEdge } from "./dependency_graph.js";
import type { IndexedFile } from "./symbol.js";

export type SemanticChangeKind =
	| "unchanged"
	| "body_changed"
	| "api_changed"
	| "dependency_changed"
	| "file_added"
	| "file_removed";

export interface SemanticChange {
	kind: SemanticChangeKind;
}

function dependencySignature(dependencies: readonly DependencyEdge[]): string {
	return dependencies
		.map((edge) => `${edge.reason}:${edge.to}`)
		.sort()
		.join("|");
}

export function classifySemanticChange(
	previous: IndexedFile | undefined,
	current: IndexedFile | undefined,
	previousDependencies: readonly DependencyEdge[] = [],
	currentDependencies: readonly DependencyEdge[] = [],
): SemanticChange {
	if (!previous && current) return { kind: "file_added" };
	if (previous && !current) return { kind: "file_removed" };
	if (!previous || !current) return { kind: "unchanged" };
	if (previous.apiFingerprint !== current.apiFingerprint) return { kind: "api_changed" };
	if (dependencySignature(previousDependencies) !== dependencySignature(currentDependencies)) {
		return { kind: "dependency_changed" };
	}
	if (previous.source !== current.source) return { kind: "body_changed" };
	return { kind: "unchanged" };
}
