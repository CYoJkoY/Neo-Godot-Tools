import type { IndexedParameter } from "./symbol.js";

export function parameterLabel(parameter: IndexedParameter): string {
	return `${parameter.name}${parameter.type ? `: ${parameter.type}` : ""}${parameter.defaultValue !== undefined ? ` = ${parameter.defaultValue}` : ""}`;
}

export function functionSignature(symbol: {
	readonly name: string;
	readonly parameters?: readonly IndexedParameter[];
	readonly returnType?: string;
}): string {
	const parameters = (symbol.parameters ?? []).map(parameterLabel).join(", ");
	return `${symbol.name}(${parameters})${symbol.returnType ? ` -> ${symbol.returnType}` : ""}`;
}
