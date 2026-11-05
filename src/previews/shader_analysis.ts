export interface ShaderDiagnostic {
	message: string;
	line: number;
}

export interface ShaderAnalysis {
	cleanSource: string;
	shaderType: string;
	renderModes: string[];
	functions: string[];
	lineCount: number;
	diagnostics: ShaderDiagnostic[];
}

export function stripShaderComments(source: string): string {
	let result = "";
	let blockComment = false;
	let lineComment = false;
	let quote: string | undefined;
	// perf: scan shader text once while preserving offsets and line endings.
	for (let index = 0; index < source.length; index++) {
		const character = source[index];
		const next = source[index + 1];
		if (blockComment) {
			if (character === "*" && next === "/") {
				result += "  ";
				index++;
			} else result += character === "\n" || character === "\r" ? character : " ";
			if (character === "*" && next === "/") blockComment = false;
			continue;
		}
		if (lineComment) {
			if (character === "\n" || character === "\r") lineComment = false;
			result += lineComment ? " " : character;
			continue;
		}
		if (quote) {
			result += character;
			if (character === "\\") {
				result += next ?? "";
				index++;
			} else if (character === quote) quote = undefined;
			continue;
		}
		if (character === '"' || character === "'") {
			quote = character;
			result += character;
		} else if (character === "/" && next === "*") {
			blockComment = true;
			result += "  ";
			index++;
		} else if (character === "/" && next === "/") {
			lineComment = true;
			result += "  ";
			index++;
		} else result += character;
	}
	return result;
}

function lineResolver(source: string): (offset: number) => number {
	const starts = [0];
	// perf: build line offsets once for logarithmic diagnostic lookups.
	for (let index = 0; index < source.length; index++) if (source.charCodeAt(index) === 10) starts.push(index + 1);
	return (offset) => {
		let low = 0;
		let high = starts.length;
		const bounded = Math.max(0, Math.min(offset, source.length));
		while (low < high) {
			const middle = (low + high) >>> 1;
			if (starts[middle] <= bounded) low = middle + 1;
			else high = middle;
		}
		return low;
	};
}

export function analyzeShaderSource(source: string): ShaderAnalysis {
	const cleanSource = stripShaderComments(source);
	const lineAt = lineResolver(source);
	const diagnostics: ShaderDiagnostic[] = [];
	const shaderType = cleanSource.match(/\bshader_type\s+([A-Za-z_][A-Za-z0-9_]*)/)?.[1] ?? "canvas_item";
	const renderModes = Array.from(cleanSource.matchAll(/\brender_mode\s+([^;]+);/g)).flatMap((match) =>
		match[1]
			.split(",")
			.map((mode) => mode.trim())
			.filter(Boolean),
	);
	const functions = Array.from(
		cleanSource.matchAll(
			/\b(?:void|bool|int|uint|float|double|vec[234]|ivec[234]|uvec[234]|mat[234]|[A-Za-z_][A-Za-z0-9_]*)\s+([A-Za-z_][A-Za-z0-9_]*)\s*\(/g,
		),
		(match) => match[1],
	);
	let depth = 0;
	let depthLine = 1;
	// perf: scan braces once; lineResolver avoids repeated prefix splitting.
	for (let index = 0; index < cleanSource.length; index++) {
		const character = cleanSource[index];
		if (character === "{") {
			if (depth === 0) depthLine = lineAt(index);
			depth++;
		} else if (character === "}") {
			if (depth === 0) diagnostics.push({ message: "Unexpected closing brace.", line: lineAt(index) });
			else depth--;
		}
	}
	if (depth > 0) diagnostics.push({ message: "Unclosed shader block.", line: depthLine });
	return {
		cleanSource,
		shaderType,
		renderModes,
		functions: [...new Set(functions)],
		lineCount: source.length === 0 ? 1 : source.split(/\r?\n/).length,
		diagnostics,
	};
}
