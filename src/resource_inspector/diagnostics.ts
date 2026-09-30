/**
 * Validation of `.tres` documents, surfaced both in the inspector panel and as
 * VS Code diagnostics.
 */

import { parseResourceDocument, ResourceDocument } from "./document.js";
import { PropertyMetadata } from "./metadata.js";
import { parseVariant, valueMatchesType, VariantValue } from "./values.js";

export interface ResourceDiagnostic {
	message: string;
	severity: "error" | "warning";
	line: number;
}

export interface ValidationOptions {
	/**
	 * Whether the metadata is *authoritative* for the resource type, i.e. it
	 * came from the engine (the connected language server) and therefore lists
	 * every property the resource can have, including inherited ones.
	 *
	 * Only then may a property that is missing from it be reported as unknown.
	 * With partial knowledge — script `@export`s alone, the properties already
	 * present in the file, or no metadata at all — perfectly valid engine
	 * properties would be flagged, which is exactly the noise the inspector has
	 * to avoid.
	 */
	complete?: boolean;
}

function visitValues(document: ResourceDocument, visit: (name: string, value: VariantValue, line: number) => void): void {
	for (const property of document.properties) visit(property.name, property.value, property.line);
	for (const subResource of document.subResources) {
		for (const property of subResource.properties) visit(`${subResource.id}.${property.name}`, property.value, property.line);
	}
}

function checkValue(
	document: ResourceDocument,
	name: string,
	raw: string,
	value: VariantValue,
	line: number,
	metadata: PropertyMetadata | undefined,
	diagnostics: ResourceDiagnostic[],
): void {
	const parsed = parseVariant(raw);
	if (parsed.error) {
		diagnostics.push({ severity: "error", message: `Unparsable value for '${name}': ${parsed.error}`, line });
	}
	if (value.kind === "ExtResource") {
		if (!document.extResources.some((resource) => resource.id === value.referenceId)) {
			diagnostics.push({ severity: "error", message: `Dangling ExtResource id '${value.referenceId}'`, line });
		}
	}
	if (value.kind === "SubResource") {
		if (!document.subResources.some((resource) => resource.id === value.referenceId)) {
			diagnostics.push({ severity: "error", message: `Dangling SubResource id '${value.referenceId}'`, line });
		}
	}
	for (const item of [...(value.items ?? []), ...(value.entries ?? []).flatMap((entry) => [entry.key, entry.value])]) {
		const nested = parseVariant(item.raw);
		if (nested.error) diagnostics.push({ severity: "error", message: `Unparsable value for '${name}': ${nested.error}`, line });
	}
	if (metadata && metadata.source !== "file" && metadata.type !== "Variant" && !valueMatchesType(value, metadata.type)) {
		diagnostics.push({ severity: "error", message: `Type mismatch for '${name}': expected ${metadata.type}`, line });
	}
}

/** Validates a parsed document, returning the problems the panel and VS Code show. */
export function validateResourceDocument(
	document: ResourceDocument,
	metadata: readonly PropertyMetadata[] = [],
	options: ValidationOptions = {},
): ResourceDiagnostic[] {
	const diagnostics: ResourceDiagnostic[] = [];
	const known = new Map(metadata.map((property) => [property.name, property]));
	// Properties that exist in the file are only known from the file itself.
	const declared = new Set(metadata.filter((property) => property.source !== "file").map((property) => property.name));
	// Default to "not authoritative": an unknown property is only worth a
	// warning when the caller can prove the property does not exist.
	const complete = options.complete ?? false;

	visitValues(document, (name, value, line) => {
		const plainName = name.includes(".") ? name.slice(name.indexOf(".") + 1) : name;
		const propertyMetadata = known.get(plainName);
		const raw = value.raw;
		checkValue(document, name, raw, value, line, propertyMetadata, diagnostics);
		if (complete && declared.size > 0 && !name.includes(".") && !declared.has(plainName)) {
			diagnostics.push({ severity: "warning", message: `Unknown property '${name}'`, line });
		}
	});

	return diagnostics;
}

export function validateResourceText(
	text: string,
	metadata: readonly PropertyMetadata[] = [],
	options: ValidationOptions = {},
): ResourceDiagnostic[] {
	return validateResourceDocument(parseResourceDocument(text), metadata, options);
}
