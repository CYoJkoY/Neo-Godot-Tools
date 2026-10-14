import { readFile } from "node:fs/promises";
import * as vscode from "vscode";
import { TextEdit } from "vscode";
import type { TextDocument, TextLine } from "vscode";
import * as oniguruma from "vscode-oniguruma";
import * as vsctm from "vscode-textmate";
import { createLogger, get_configuration, get_extension_uri, is_debug_mode } from "../utils";
import { keywords, symbols } from "./symbols";

const log = createLogger("formatter.tm");
const grammarPath = get_extension_uri("syntaxes/GDScript.tmLanguage.json").fsPath;
const wasmPath = get_extension_uri("resources/onig.wasm").fsPath;
let grammar: vsctm.IGrammar | null = null;
let grammarPromise: Promise<vsctm.IGrammar | null> | undefined;

/** Delay loading/compiling TextMate's WASM grammar until formatting is requested. */
function ensureGrammar(): Promise<vsctm.IGrammar | null> {
	if (!grammarPromise) {
		grammarPromise = (async () => {
			const wasm = await readFile(wasmPath);
			const wasmBytes = wasm.buffer.slice(wasm.byteOffset, wasm.byteOffset + wasm.byteLength);
			await oniguruma.loadWASM(wasmBytes as unknown as oniguruma.IOptions);
			const registry = new vsctm.Registry({
				onigLib: Promise.resolve({
					createOnigScanner: (patterns) => new oniguruma.OnigScanner(patterns),
					createOnigString: (value) => new oniguruma.OnigString(value),
				}),
				loadGrammar: async (scopeName) => {
					if (scopeName !== "source.gdscript") return undefined;
					const data = await readFile(grammarPath);
					return vsctm.parseRawGrammar(data.toString(), grammarPath);
				},
			});
			grammar = await registry.loadGrammar("source.gdscript");
			return grammar;
		})().catch((error) => {
			log.error("Failed to load the GDScript formatter grammar", error);
			grammarPromise = undefined;
			return null;
		});
	}
	return grammarPromise ?? Promise.resolve(null);
}

interface Token {
	scopes: string;
	original: string;
	value: string;
	type?: string;
	param?: boolean;
	string?: boolean;
	skip?: boolean;
	identifier?: boolean;
	inLambdaBody?: boolean;
}

export interface FormatterOptions {
	maxEmptyLines: number;
	denseFunctionParameters: boolean;
	spacesBeforeEndOfLineComment: 1 | 2;
	maxLineLength?: number;
	continuationIndentLevel?: number;
}

function get_formatter_options() {
	const rawMaxEmptyLines = get_configuration("formatter.maxEmptyLines");
	const maxEmptyLines = typeof rawMaxEmptyLines === "number" ? Math.max(0, Math.round(rawMaxEmptyLines)) : 2;
	const rawMaxLineLength = get_configuration("formatter.maxLineLength");
	const maxLineLength =
		typeof rawMaxLineLength === "number" && Number.isFinite(rawMaxLineLength)
			? Math.max(40, Math.min(240, Math.round(rawMaxLineLength)))
			: 100;
	const rawContinuationIndentLevel = get_configuration("formatter.continuationIndentLevel");
	const continuationIndentLevel =
		typeof rawContinuationIndentLevel === "number" && Number.isFinite(rawContinuationIndentLevel)
			? Math.max(1, Math.min(4, Math.round(rawContinuationIndentLevel)))
			: 2;

	const options: FormatterOptions = {
		maxEmptyLines: maxEmptyLines,
		denseFunctionParameters: get_configuration("formatter.denseFunctionParameters", false),
		spacesBeforeEndOfLineComment: get_configuration("formatter.spacesBeforeEndOfLineComment") === "1" ? 1 : 2,
		maxLineLength,
		continuationIndentLevel,
	};

	return options;
}

function parse_token(token: Token) {
	if (token.scopes.includes("string.quoted.gdscript")) {
		token.string = true;
	}
	if (token.scopes.includes("meta.function.parameters.gdscript")) {
		token.param = true;
	}
	if (token.scopes.includes("constant.numeric")) {
		token.type = "literal";
		return;
	}
	if (token.value.match(/[A-Za-z_]\w+/)) {
		token.identifier = true;
	}
	if (token.scopes.includes("meta.literal.nodepath.gdscript")) {
		token.skip = true;
		token.type = "nodepath";
		return;
	}
	if (token.scopes.includes("meta.literal.nodepath.bare.gdscript")) {
		token.skip = true;
		token.type = "bare_nodepath";
		return;
	}
	if (token.scopes.includes("keyword.control.flow.gdscript")) {
		token.type = "keyword";
		return;
	}
	// "preload" is highlighted as a keyword but it behaves like a function
	if (token.value === "preload") {
		return;
	}
	// "self" and "super" are highlighted as keywords but behave like identifiers
	if (token.value === "self" || token.value === "super") {
		token.type = "variable";
		return;
	}
	// "signal" is a keyword in declarations but a value reference in expressions
	// (e.g. yield(signal, "completed")). Trust the grammar scope.
	if (token.value === "signal") {
		if (token.scopes.includes("keyword.language.gdscript")) {
			token.type = "keyword";
		} else {
			token.type = "variable";
		}
		return;
	}
	// "yield" is a keyword but behaves like a function call — no space before (
	if (token.value === "yield") {
		token.type = "keyword";
		return;
	}
	if (keywords.includes(token.value)) {
		token.type = "keyword";
		return;
	}
	if (symbols.includes(token.value)) {
		token.type = "symbol";
		return;
	}
	if (token.scopes.includes("keyword.language.gdscript")) {
		token.type = "keyword";
		return;
	}
	if (
		token.scopes.includes("constant.language.gdscript") ||
		token.scopes.includes("constant.language.literal.gdscript")
	) {
		token.type = "constant";
		return;
	}
	if (token.scopes.includes("variable.other.gdscript")) {
		token.type = "variable";
		return;
	}
	if (token.scopes.includes("comment.line.number-sign.gdscript")) {
		token.type = "comment";
		return;
	}
}

function between(tokens: Token[], current: number, options: FormatterOptions) {
	const nextToken = tokens[current];
	const prevToken = tokens[current - 1];
	const next = nextToken.value;
	const prev = prevToken?.value;

	// console.log(prevToken, nextToken);

	if (!prev) return "";

	if (next === "##") return options.spacesBeforeEndOfLineComment === 2 ? "  " : " ";
	if (next === "#") return options.spacesBeforeEndOfLineComment === 2 ? "  " : " ";
	if (prevToken.skip && nextToken.skip) return "";

	if (prev === "(") return "";
	if (prev === ".") {
		if (nextToken?.type === "symbol") return " ";
		return "";
	}
	if (next === ".") return "";

	if (nextToken.param && !nextToken.inLambdaBody && !prevToken?.inLambdaBody) {
		if (options.denseFunctionParameters) {
			if (prev === "-" || prev === "+") {
				if (tokens[current - 2]?.value === "=") return "";
				if (["keyword", "symbol"].includes(tokens[current - 2]?.type ?? "")) {
					return "";
				}
				if ([",", "("].includes(tokens[current - 2]?.value)) {
					return "";
				}
			}
			if (next === "%") return " ";
			if (prev === "%") return " ";
			if (next === "=") {
				if (tokens[current - 2]?.value === ":") return " ";
				return "";
			}
			if (prev === "=") {
				if (tokens[current - 3]?.value === ":") return " ";
				return "";
			}
			if (prevToken?.type === "symbol") return " ";
			if (nextToken.type === "symbol") return " ";
		} else {
			if (next === ":") {
				if (tokens[current + 1]?.value === "=") return " ";
			}
		}
	}

	if (next === ":") {
		if (["var", "const"].includes(tokens[current - 2]?.value)) {
			if (tokens[current + 1]?.value !== "=") return "";
			return " ";
		}
		if (prevToken?.type === "keyword") return "";
	}
	if (prev === "@") return "";

	if (prev === "-" || prev === "+") {
		if (next === "(") return " ";
		if (["keyword", "symbol"].includes(tokens[current - 2]?.type ?? "")) {
			return "";
		}
		if ([",", "(", "["].includes(tokens[current - 2]?.value)) {
			return "";
		}
		if (tokens[current - 2]?.value === "=") {
			return "";
		}
		if (nextToken.identifier) return " ";
		if (current === 1) return "";
	}

	if (prev === ":" && next === "=") return "";
	if (next === "(") {
		if (prev === "export") return "";
		if (prev === "func") return "";
		if (prev === "assert") return "";
		if (prev === "yield") return "";
	}

	if (prev === ")" && nextToken.type === "keyword") return " ";

	if (prev === "[" && nextToken.type === "symbol") return "";
	if (prev === "[" && nextToken.type === "nodepath") return "";
	if (prev === "[" && nextToken.type === "bare_nodepath") return "";
	if (prev === ":") return " ";
	if (prev === ";") return " ";
	if (prev === "##") return " ";
	if (prev === "#") return " ";
	if (next === "=") return " ";
	if (prev === "=") return " ";
	if (tokens[current - 2]?.value === "=") {
		if (["+", "-"].includes(prev)) return "";
	}
	if (prev === "(") return "";
	if (next === "{") return " ";
	if (next === "\\") return " ";
	if (next === "{}") return " ";

	if (prevToken?.type === "keyword") return " ";
	if (nextToken.type === "keyword") return " ";
	if (prevToken?.type === "symbol") return " ";
	if (nextToken.type === "symbol") return " ";

	if (prev === ",") return " ";

	return "";
}

function is_comment(line: TextLine): boolean {
	return line.text[line.firstNonWhitespaceCharacterIndex] === "#";
}

function is_merge_conflict_marker(line: TextLine): boolean {
	const trimmed = line.text.trimStart();
	return trimmed.startsWith("<<<<<<<") || trimmed.startsWith("=======") || trimmed.startsWith(">>>>>>>");
}

function get_max_line_length(options: FormatterOptions): number {
	const configuredLength = options.maxLineLength;
	return typeof configuredLength === "number" && Number.isFinite(configuredLength)
		? Math.max(40, Math.min(240, Math.round(configuredLength)))
		: 100;
}

function get_indentation_unit(document: TextDocument, leadingWhitespace: string): string {
	const editorConfiguration = vscode.workspace.getConfiguration("editor", document.uri);
	const configuredTabSize = editorConfiguration.get<number>("tabSize", 4);
	const tabSize =
		typeof configuredTabSize === "number" && Number.isFinite(configuredTabSize)
			? Math.max(1, Math.min(8, Math.round(configuredTabSize)))
			: 4;
	const configuredInsertSpaces = editorConfiguration.get<boolean>("insertSpaces", false);
	const indentationSample =
		leadingWhitespace.length > 0 ? leadingWhitespace : (document.getText().match(/^[ \t]+(?=\S)/m)?.[0] ?? "");
	const hasSpaceIndent = indentationSample.includes(" ");
	const hasTabIndent = indentationSample.includes("\t");
	const insertSpaces = hasSpaceIndent !== hasTabIndent ? hasSpaceIndent : configuredInsertSpaces;
	return insertSpaces ? " ".repeat(tabSize) : "\t";
}

function wrap_long_boolean_condition(
	tokens: Token[],
	renderedTokens: string[],
	leadingWhitespace: string,
	currentLine: string,
	document: TextDocument,
	options: FormatterOptions,
): string | undefined {
	const maxLineLength = get_max_line_length(options);
	if (currentLine.length <= maxLineLength) return undefined;

	const controlKeyword = tokens[0]?.value;
	if (!["if", "elif", "while"].includes(controlKeyword ?? "")) return undefined;

	const endIndex = tokens.length - 1;
	if (endIndex < 3 || tokens[endIndex]?.value !== ":" || tokens[endIndex]?.string) return undefined;
	if (
		tokens.some(
			(token, index) =>
				token.type === "comment" ||
				(token.value.length === 1 && token.value.charCodeAt(0) === 92) ||
				token.value === ";" ||
				(index > 0 && token.value === "else" && !token.string),
		)
	) {
		return undefined;
	}

	const scan = scan_token_boundaries(tokens, 1, endIndex);
	const splitIndexes = scan.topLevelIndexes.filter(
		(tokenIndex) => ["and", "or"].includes(tokens[tokenIndex].value),
	);
	if (!scan.valid || splitIndexes.length === 0) return undefined;

	const boundaries = [...splitIndexes, endIndex];
	const terms = boundaries.map((end, index) => {
		const start = index === 0 ? 1 : boundaries[index - 1];
		return renderedTokens.slice(start, end).join("").trim();
	});
	if (terms.some((term) => term.length === 0)) return undefined;

	const configuredIndentLevel = options.continuationIndentLevel;
	const continuationIndentLevel =
		typeof configuredIndentLevel === "number" && Number.isFinite(configuredIndentLevel)
			? Math.max(1, Math.min(4, Math.round(configuredIndentLevel)))
			: 2;
	const indentationUnit = get_indentation_unit(document, leadingWhitespace);
	const continuationIndent = leadingWhitespace + indentationUnit.repeat(continuationIndentLevel);

	return `${leadingWhitespace}${renderedTokens[0].trim()} (\n${terms
		.map((term) => `${continuationIndent}${term}`)
		.join("\n")}\n${leadingWhitespace}):`;
}

/**
 * Wrap a long single-line function call when top-level argument commas provide
 * safe split points. Unsupported shapes remain untouched.
 */
function wrap_long_function_call(
	tokens: Token[],
	renderedTokens: string[],
	leadingWhitespace: string,
	currentLine: string,
	document: TextDocument,
	options: FormatterOptions,
): string | undefined {
	const maxLineLength = get_max_line_length(options);
	if (currentLine.length <= maxLineLength || tokens[0]?.string) return undefined;

	const firstValue = tokens[0]?.value ?? "";
	if (
		firstValue.startsWith("@") ||
		["if", "elif", "while", "for", "match", "signal", "enum"].includes(firstValue)
	) {
		return undefined;
	}
	if (
		tokens.some(
			(token) =>
				token.type === "comment" ||
				(!token.string &&
					(token.value === "func" ||
						token.value === ";" ||
						(token.value.length === 1 && token.value.charCodeAt(0) === 92))),
		)
	) {
		return undefined;
	}

	const boundaryScan = scan_token_boundaries(tokens);
	if (!boundaryScan.valid) return undefined;
	const matchingClosers = new Map(
		[...boundaryScan.matchingClosers.entries()].filter(
			([openIndex]) => tokens[openIndex]?.value === "(",
		),
	);
	const configuredIndentLevel = options.continuationIndentLevel;
	const continuationIndentLevel =
		typeof configuredIndentLevel === "number" && Number.isFinite(configuredIndentLevel)
			? Math.max(1, Math.min(4, Math.round(configuredIndentLevel)))
			: 2;
	const indentationUnit = get_indentation_unit(document, leadingWhitespace);
	const continuationIndent = leadingWhitespace + indentationUnit.repeat(continuationIndentLevel);

	for (const [openIndex, closeIndex] of [...matchingClosers.entries()].sort((leftPair, rightPair) => leftPair[0] - rightPair[0])) {
		const callableToken = tokens[openIndex - 1];
		const isCallable =
			callableToken !== undefined &&
			!callableToken.string &&
			((callableToken.identifier === true &&
				(callableToken.type !== "keyword" || ["assert", "yield"].includes(callableToken.value))) ||
				[")", "]"].includes(callableToken.value));
		if (!isCallable) continue;

		const argumentScan = scan_token_boundaries(tokens, openIndex + 1, closeIndex);
		const commaIndexes = argumentScan.topLevelIndexes.filter(
			(tokenIndex) => tokens[tokenIndex].value === ",",
		);
		if (!argumentScan.valid || commaIndexes.length === 0) continue;


		const argumentSegments: string[] = [];
		let segmentStart = openIndex + 1;
		for (const commaIndex of commaIndexes) {
			const argumentText = renderedTokens.slice(segmentStart, commaIndex).join("").trim();
			if (!argumentText) {
				valid = false;
				break;
			}
			argumentSegments.push(argumentText);
			segmentStart = commaIndex + 1;
		}
		if (!valid) continue;
		const finalArgument = renderedTokens.slice(segmentStart, closeIndex).join("").trim();
		if (!finalArgument) continue;
		argumentSegments.push(finalArgument);

		const prefix = renderedTokens.slice(0, openIndex + 1).join("");
		const suffix = renderedTokens.slice(closeIndex + 1).join("");
		const firstLine = leadingWhitespace + prefix;
		const wrappedLines = [
			firstLine,
			...argumentSegments.map((argumentText, argumentIndex) => {
				const isLastArgument = argumentIndex === argumentSegments.length - 1;
				return `${continuationIndent}${argumentText}${isLastArgument ? `)${suffix}` : ","}`;
			}),
		];

		// Keep the transform idempotent: if any generated line is still too long,
		// leave this call unchanged rather than requiring another formatting pass.
		if (wrappedLines.some((wrappedLine) => wrappedLine.length > maxLineLength)) continue;
		return wrappedLines.join("\n");
	}

	return undefined;
}


const arrayLiteralPrefixes = new Set([
	"=",
	":=",
	"(",
	",",
	":",
	"[",
	"{",
	"return",
	"in",
	"else",
	"not",
	"await",
	"yield",
]);
const openingDelimiters = new Set(["(", "[", "{"]);
const closingDelimiters = new Map([
	[")", "("],
	["]", "["],
	["}", "{"],
]);

interface TokenBoundaryScan {
	valid: boolean;
	topLevelIndexes: number[];
	matchingClosers: Map<number, number>;
}

/**
 * Finds syntax boundaries without interpreting GDScript operators or keywords.
 * Strings and comments are opaque; malformed delimiter ranges fail closed.
 */
function scan_token_boundaries(
	tokens: Token[],
	startIndex = 0,
	endIndex = tokens.length,
): TokenBoundaryScan {
	const stack: { index: number; value: string }[] = [];
	const topLevelIndexes: number[] = [];
	const matchingClosers = new Map<number, number>();
	let valid = true;

	for (let tokenIndex = startIndex; tokenIndex < endIndex; tokenIndex++) {
		const currentToken = tokens[tokenIndex];
		if (currentToken.string || currentToken.type === "comment") continue;

		if (stack.length === 0) topLevelIndexes.push(tokenIndex);
		if (openingDelimiters.has(currentToken.value)) {
			stack.push({ index: tokenIndex, value: currentToken.value });
			continue;
		}

		const expectedOpening = closingDelimiters.get(currentToken.value);
		if (expectedOpening === undefined) continue;

		const openingToken = stack.pop();
		if (!openingToken || openingToken.value !== expectedOpening) {
			valid = false;
			continue;
		}
		matchingClosers.set(openingToken.index, tokenIndex);
	}

	return { valid: valid && stack.length === 0, topLevelIndexes, matchingClosers };
}


function wrap_collection_candidate(
	tokens: Token[],
	renderedTokens: string[],
	leadingWhitespace: string,
	maxLineLength: number,
	collectionIndent: string,
	openIndex: number,
	closeIndex: number,
): string | undefined {
	const openingValue = tokens[openIndex].value;
	if (openingValue === "[") {
		const previousToken = tokens[openIndex - 1];
		const previousValue = previousToken?.value;
		const isArrayLiteral =
			previousToken === undefined ||
			arrayLiteralPrefixes.has(previousValue ?? "") ||
			previousToken.type === "symbol";
		if (!isArrayLiteral) return undefined;
	}

	const scan = scan_token_boundaries(tokens, openIndex + 1, closeIndex);
	const commaIndexes = scan.topLevelIndexes.filter(
		(tokenIndex) => tokens[tokenIndex].value === ",",
	);
	if (!scan.valid || commaIndexes.length === 0) return undefined;

	const lastCommaIndex = commaIndexes[commaIndexes.length - 1];
	const hasTrailingComma = lastCommaIndex === closeIndex - 1;
	const contentEnd = hasTrailingComma ? closeIndex - 1 : closeIndex;
	const segmentResult = commaIndexes.reduce(
		(state, commaIndex) => {
			if (!state.valid || commaIndex >= contentEnd) return state;

			const elementText = renderedTokens.slice(state.segmentStart, commaIndex).join("").trim();
			if (!elementText) {
				state.valid = false;
				return state;
			}
			state.segments.push(elementText);
			state.segmentStart = commaIndex + 1;
			return state;
		},
		{
			valid: true,
			segments: [] as string[],
			segmentStart: openIndex + 1,
		},
	);
	if (!segmentResult.valid) return undefined;

	const finalElement = renderedTokens.slice(segmentResult.segmentStart, contentEnd).join("").trim();
	const segments = finalElement ? segmentResult.segments.concat(finalElement) : segmentResult.segments;
	if ((!finalElement && !hasTrailingComma) || segments.length < 2) return undefined;

	const prefix = renderedTokens.slice(0, openIndex + 1).join("");
	const suffix = renderedTokens.slice(closeIndex + 1).join("");
	const firstLine = leadingWhitespace + prefix;
	const closingLine = leadingWhitespace + tokens[closeIndex].value + suffix;
	const wrappedLines = [
		firstLine,
		...segments.map((segment) => `${collectionIndent}${segment},`),
		closingLine,
	];

	// Do not produce unstable output when an element or the surrounding expression
	// cannot fit within the configured line length.
	return wrappedLines.some((wrappedLine) => wrappedLine.length > maxLineLength)
		? undefined
		: wrappedLines.join("\n");
}

/**
 * Wrap long inline arrays and dictionary literals at top-level commas.
 * Collections use one continuation indent level per the GDScript style guide.
 */
function wrap_long_collection_literal(
	tokens: Token[],
	renderedTokens: string[],
	leadingWhitespace: string,
	currentLine: string,
	document: TextDocument,
	options: FormatterOptions,
): string | undefined {
	const maxLineLength = get_max_line_length(options);
	if (currentLine.length <= maxLineLength || tokens[0]?.string) return undefined;

	const firstValue = tokens[0]?.value ?? "";
	if (
		firstValue.startsWith("@") ||
		["class", "enum", "func", "if", "elif", "while", "for", "match", "signal"].includes(firstValue)
	) {
		return undefined;
	}
	if (
		tokens.some(
			(token) =>
				token.type === "comment" ||
				(!token.string &&
					(token.value === "func" ||
						token.value === ";" ||
						(token.value.length === 1 && token.value.charCodeAt(0) === 92))),
		)
	) {
		return undefined;
	}

	const delimiterScan = scan_token_boundaries(tokens);
	if (!delimiterScan.valid) return undefined;

	const collectionIndent = leadingWhitespace + get_indentation_unit(document, leadingWhitespace);
	return [...delimiterScan.matchingClosers.entries()]
		.filter(([openIndex]) => ["[", "{"].includes(tokens[openIndex].value))
		.sort((leftPair, rightPair) => leftPair[0] - rightPair[0])
		.reduce<string | undefined>((matchedLine, [openIndex, closeIndex]) => {
			if (matchedLine !== undefined) return matchedLine;
			return wrap_collection_candidate(
				tokens,
				renderedTokens,
				leadingWhitespace,
				maxLineLength,
				collectionIndent,
				openIndex,
				closeIndex,
			);
		}, undefined);
}

export async function format_document_async(document: TextDocument, options?: FormatterOptions): Promise<TextEdit[]> {
	await ensureGrammar();
	return format_document(document, options);
}


/**
 * Wrap eligible long ternary expressions in assignments and return statements.
 * Only clear top-level if/else sequences are transformed; unsupported shapes stay unchanged.
 */
function wrap_long_ternary_expression(
	tokens: Token[],
	renderedTokens: string[],
	leadingWhitespace: string,
	currentLine: string,
	document: TextDocument,
	options: FormatterOptions,
): string | undefined {
	const maxLineLength = get_max_line_length(options);
	if (currentLine.length <= maxLineLength || tokens[0]?.string) return undefined;

	const firstValue = tokens[0]?.value ?? "";
	if (
		firstValue.startsWith("@") ||
		["class", "enum", "func", "if", "elif", "while", "for", "match", "signal"].includes(firstValue)
	) {
		return undefined;
	}
	if (
		tokens.some(
			(token) =>
				token.type === "comment" ||
				(!token.string &&
					(token.value === "func" ||
						token.value === ";" ||
						(token.value.length === 1 && token.value.charCodeAt(0) === 92))),
		)
	) {
		return undefined;
	}

	const boundaryScan = scan_token_boundaries(tokens);
	const markers = boundaryScan.topLevelIndexes.flatMap((tokenIndex) => {
		const value = tokens[tokenIndex].value;
		return value === "if" || value === "else" ? [{ index: tokenIndex, value }] : [];
	});
	const assignmentIndexes = boundaryScan.topLevelIndexes.filter(
		(tokenIndex) => tokens[tokenIndex].value === "=" || tokens[tokenIndex].value === ":=",
	);
	const markerSequenceIsValid =
		boundaryScan.valid &&
		markers.length >= 2 &&
		markers.length % 2 === 0 &&
		markers.every((marker, index) => marker.value === (index % 2 === 0 ? "if" : "else"));
	if (!markerSequenceIsValid) return undefined;

	const firstIfIndex = markers[0].index;
	const assignmentIndex = assignmentIndexes.reduce(
		(matchedIndex, currentIndex) =>
			currentIndex < firstIfIndex && currentIndex > matchedIndex ? currentIndex : matchedIndex,
		-1,
	);
	const expressionStart = firstValue === "return" ? 1 : assignmentIndex + 1;
	if (expressionStart <= 0 && firstValue !== "return") return undefined;
	if (expressionStart >= firstIfIndex) return undefined;

	const elseIndexes = markers
		.filter((marker) => marker.value === "else")
		.map((marker) => marker.index);
	const segments = [...elseIndexes, tokens.length].map((endIndex, segmentIndex) => {
		const segmentStart = segmentIndex === 0 ? expressionStart : elseIndexes[segmentIndex - 1];
		return renderedTokens.slice(segmentStart, endIndex).join("").trim();
	});
	if (segments.some((segment) => segment.length === 0)) return undefined;

	const configuredIndentLevel = options.continuationIndentLevel;
	const continuationIndentLevel =
		typeof configuredIndentLevel === "number" && Number.isFinite(configuredIndentLevel)
			? Math.max(1, Math.min(4, Math.round(configuredIndentLevel)))
			: 2;
	const indentationUnit = get_indentation_unit(document, leadingWhitespace);
	const continuationIndent = leadingWhitespace + indentationUnit.repeat(continuationIndentLevel);
	const expressionPrefix =
		renderedTokens.slice(0, expressionStart).join("") + between(tokens, expressionStart, options);
	const firstLine = `${leadingWhitespace + expressionPrefix}(`;
	const wrappedLines = [
		firstLine,
		...segments.map((segment) => `${continuationIndent}${segment}`),
		`${leadingWhitespace})`,
	];

	return wrappedLines.some((wrappedLine) => wrappedLine.length > maxLineLength)
		? undefined
		: wrappedLines.join("\n");
}

/** Synchronous entry point retained for callers that have already loaded the grammar. */
export function format_document(document: TextDocument, _options?: FormatterOptions): TextEdit[] {
	const activeGrammar = grammar;
	if (!activeGrammar) return [];
	const edits: TextEdit[] = [];

	const options = _options ?? get_formatter_options();
	const debug = is_debug_mode();

	let lastToken = "";
	let lineTokens: vsctm.ITokenizeLineResult | undefined = undefined;
	let onlyEmptyLinesSoFar = true;
	let emptyLineCount = 0;
	let inLambdaBody = false;
	for (let lineNum = 0; lineNum < document.lineCount; lineNum++) {
		const line = document.lineAt(lineNum);

		// Advance lexical state before any skip path. Lines that look like comments,
		// blank lines, or conflict markers can still occur inside multiline strings.
		lineTokens = activeGrammar.tokenizeLine(line.text, lineTokens?.ruleStack ?? vsctm.INITIAL);

		// skip empty lines
		if (line.isEmptyOrWhitespace) {
			// delete empty lines at the beginning of the file
			if (onlyEmptyLinesSoFar) {
				edits.push(TextEdit.delete(line.rangeIncludingLineBreak));
			} else {
				emptyLineCount++;
			}

			// delete empty lines at the end of the file
			if (lineNum === document.lineCount - 1) {
				for (let i = lineNum - emptyLineCount + 1; i < document.lineCount; i++) {
					edits.push(TextEdit.delete(document.lineAt(i).rangeIncludingLineBreak));
				}
			}
			continue;
		}
		onlyEmptyLinesSoFar = false;

		// delete consecutive empty lines
		if (emptyLineCount) {
			let maxEmptyLines = options.maxEmptyLines;
			if (lastToken === ":") {
				maxEmptyLines = 0;
			}
			for (let i = emptyLineCount - maxEmptyLines; i > 0; i--) {
				edits.push(TextEdit.delete(document.lineAt(lineNum - i).rangeIncludingLineBreak));
			}
			emptyLineCount = 0;
		}

		// skip comments
		if (is_comment(line)) {
			continue;
		}

		// skip git merge conflict markers — formatting these corrupts them
		if (is_merge_conflict_marker(line)) {
			continue;
		}

		// TODO: detect whitespace type and automatically convert
		const leadingWhitespace = line.text.slice(0, line.firstNonWhitespaceCharacterIndex);
		let firstToken = 0;
		const first = lineTokens.tokens[0];
		if (first && line.text.slice(first.startIndex, first.endIndex).trim() === "") firstToken = 1;

		const tokens: Token[] = [];
		for (let tokenIndex = firstToken; tokenIndex < lineTokens.tokens.length; tokenIndex++) {
			const t = lineTokens.tokens[tokenIndex];
			const original = line.text.slice(t.startIndex, t.endIndex);
			const token: Token = {
				scopes: t.scopes.join(" "),
				original,
				value: original.trim(),
			};
			parse_token(token);
			// skip whitespace tokens
			if (!token.string && token.value.trim() === "") {
				continue;
			}
			tokens.push(token);
		}
		// Track lambda bodies inside function call parameters.
		// When func() appears as a call argument, everything after it until
		// the closing ) of the outer call is a lambda body, and dense
		// parameter formatting should not apply there.
		let sawLambdaStart = false;
		for (let i = 0; i < tokens.length; i++) {
			if (tokens[i].value === "func" && tokens[i].param) {
				sawLambdaStart = true;
				inLambdaBody = true;
			}
			// The closing ) of the outer call is not in param scope.
			// When we see it, we've exited the lambda body.
			if (tokens[i].value === ")" && !tokens[i].param) {
				inLambdaBody = false;
			}
			// Mark tokens inside the lambda body (but not the func/parens/colon
			// that start it, which should still get dense formatting).
			// The lambda start tokens (func, (, ), :) come before the body
			// content, so we only mark tokens after the lambda start colon.
			if (inLambdaBody && sawLambdaStart && tokens[i].value === ":") {
				sawLambdaStart = false; // colon is structural, don't mark it
			} else if (inLambdaBody && !sawLambdaStart) {
				tokens[i].inLambdaBody = true;
			}
		}
		const renderedTokens: string[] = [];
		for (let i = 0; i < tokens.length; i++) {
			if (debug) log.debug(i, tokens[i].value, tokens[i]);

			if (i === 0 && tokens[i].string) {
				// leading whitespace is already accounted for
				renderedTokens.push(tokens[i].original.trimStart());
			} else if (i > 0 && tokens[i - 1].string && tokens[i].string) {
				renderedTokens.push(tokens[i].original);
			} else {
				renderedTokens.push(between(tokens, i, options) + tokens[i].value.trim());
			}
			if (tokens[i].type !== "comment") {
				lastToken = tokens[i].value;
			}
		}

		const nextLine = leadingWhitespace + renderedTokens.join("");
		const formattedLine =
			wrap_long_function_declaration(tokens, renderedTokens, leadingWhitespace, nextLine, document, options) ??
			wrap_long_boolean_condition(tokens, renderedTokens, leadingWhitespace, nextLine, document, options) ??
			wrap_long_ternary_expression(tokens, renderedTokens, leadingWhitespace, nextLine, document, options) ??
			wrap_long_boolean_expression(tokens, renderedTokens, leadingWhitespace, nextLine, document, options) ??
			wrap_long_function_call(tokens, renderedTokens, leadingWhitespace, nextLine, document, options) ??
			wrap_long_collection_literal(tokens, renderedTokens, leadingWhitespace, nextLine, document, options) ??
			wrap_long_additive_expression(tokens, renderedTokens, leadingWhitespace, nextLine, document, options) ??
			wrap_long_method_chain(tokens, renderedTokens, leadingWhitespace, nextLine, document, options) ??
			nextLine;

		// Returning edits for unchanged lines costs allocations and slows VS Code's
		// edit application on large scripts. Keep only actual replacements.
		if (formattedLine !== line.text) edits.push(TextEdit.replace(line.range, formattedLine));
	}

	return edits;
}

/**
 * Wrap long boolean expressions in assignments and return statements.
 * Preserve nested expressions and leave top-level ternaries to their dedicated formatter.
 */
function wrap_long_boolean_expression(
	tokens: Token[],
	renderedTokens: string[],
	leadingWhitespace: string,
	currentLine: string,
	document: TextDocument,
	options: FormatterOptions,
): string | undefined {
	const maxLineLength = get_max_line_length(options);
	if (currentLine.length <= maxLineLength || tokens[0]?.string) return undefined;

	const firstValue = tokens[0]?.value ?? "";
	if (
		firstValue.startsWith("@") ||
		["class", "enum", "func", "if", "elif", "while", "for", "match", "signal"].includes(firstValue)
	) {
		return undefined;
	}
	if (
		tokens.some(
			(token) =>
				token.type === "comment" ||
				(!token.string &&
					(token.value === "func" ||
						token.value === ";" ||
						(token.value.length === 1 && token.value.charCodeAt(0) === 92))),
		)
	) {
		return undefined;
	}

	const boundaryScan = scan_token_boundaries(tokens);
	const splitIndexes = boundaryScan.topLevelIndexes.filter((tokenIndex) =>
		["and", "or"].includes(tokens[tokenIndex].value),
	);
	const assignmentIndexes = boundaryScan.topLevelIndexes.filter(
		(tokenIndex) => tokens[tokenIndex].value === "=" || tokens[tokenIndex].value === ":=",
	);
	const hasTernaryMarker = boundaryScan.topLevelIndexes.some((tokenIndex) =>
		["if", "else"].includes(tokens[tokenIndex].value),
	);
	if (!boundaryScan.valid || hasTernaryMarker || splitIndexes.length === 0) return undefined;

	const firstSplitIndex = splitIndexes[0];
	const assignmentIndex = assignmentIndexes.reduce(
		(matchedIndex, currentIndex) =>
			currentIndex < firstSplitIndex && currentIndex > matchedIndex ? currentIndex : matchedIndex,
		-1,
	);
	const expressionStart = firstValue === "return" ? 1 : assignmentIndex + 1;
	if (expressionStart <= 0 && firstValue !== "return") return undefined;
	if (expressionStart >= firstSplitIndex) return undefined;

	const segments = [...splitIndexes, tokens.length].map((endIndex, segmentIndex) => {
		const segmentStart = segmentIndex === 0 ? expressionStart : splitIndexes[segmentIndex - 1];
		return renderedTokens.slice(segmentStart, endIndex).join("").trim();
	});
	if (segments.some((segment) => segment.length === 0)) return undefined;

	const configuredIndentLevel = options.continuationIndentLevel;
	const continuationIndentLevel =
		typeof configuredIndentLevel === "number" && Number.isFinite(configuredIndentLevel)
			? Math.max(1, Math.min(4, Math.round(configuredIndentLevel)))
			: 2;
	const indentationUnit = get_indentation_unit(document, leadingWhitespace);
	const continuationIndent = leadingWhitespace + indentationUnit.repeat(continuationIndentLevel);
	const expressionPrefix =
		renderedTokens.slice(0, expressionStart).join("") + between(tokens, expressionStart, options);
	const firstLine = `${leadingWhitespace + expressionPrefix}(`;
	const wrappedLines = [
		firstLine,
		...segments.map((segment) => `${continuationIndent}${segment}`),
		`${leadingWhitespace})`,
	];

	return wrappedLines.some((wrappedLine) => wrappedLine.length > maxLineLength)
		? undefined
		: wrappedLines.join("\n");
}


/**
 * Wrap eligible long, single-line GDScript function declarations.
 * Only top-level parameter commas are split; unsupported signatures stay unchanged.
 */
function wrap_long_function_declaration(
	tokens: Token[],
	renderedTokens: string[],
	leadingWhitespace: string,
	currentLine: string,
	document: TextDocument,
	options: FormatterOptions,
): string | undefined {
	const maxLineLength = get_max_line_length(options);
	if (currentLine.length <= maxLineLength || tokens[0]?.string) return undefined;

	const functionIndex = tokens[0]?.value === "static" ? 1 : 0;
	if (tokens[functionIndex]?.value !== "func") return undefined;
	if (tokens[functionIndex + 2]?.value !== "(") return undefined;
	if (tokens[tokens.length - 1]?.value !== ":") return undefined;

	if (
		tokens.some(
			(token) =>
				token.type === "comment" ||
				(!token.string &&
					(token.value === ";" ||
						(token.value.length === 1 && token.value.charCodeAt(0) === 92))),
		)
	) {
		return undefined;
	}

	const openIndex = functionIndex + 2;
	const delimiterScan = scan_token_boundaries(tokens, openIndex);
	const closeIndex = delimiterScan.matchingClosers.get(openIndex) ?? -1;
	if (!delimiterScan.valid || closeIndex <= openIndex) return undefined;

	const parameterScan = scan_token_boundaries(tokens, openIndex + 1, closeIndex);
	const commaIndexes = parameterScan.topLevelIndexes.filter(
		(tokenIndex) => tokens[tokenIndex].value === ",",
	);
	if (!parameterScan.valid || commaIndexes.length === 0) return undefined;

	const parameterCollection = commaIndexes.reduce(
		(state, commaIndex) => {
			const parameterText = renderedTokens.slice(state.nextStart, commaIndex).join("").trim();
			if (!parameterText) {
				state.valid = false;
				return state;
			}
			state.parameterTexts.push(parameterText);
			state.nextStart = commaIndex + 1;
			return state;
		},
		{ valid: true, parameterTexts: [] as string[], nextStart: openIndex + 1 },
	);
	if (!parameterCollection.valid) return undefined;

	const finalParameter = renderedTokens.slice(parameterCollection.nextStart, closeIndex).join("").trim();
	// Do not guess how a trailing comma should be presented in a wrapped signature.
	if (!finalParameter) return undefined;
	const parameterTexts = [...parameterCollection.parameterTexts, finalParameter];

	const configuredIndentLevel = options.continuationIndentLevel;
	const continuationIndentLevel =
		typeof configuredIndentLevel === "number" && Number.isFinite(configuredIndentLevel)
			? Math.max(1, Math.min(4, Math.round(configuredIndentLevel)))
			: 2;
	const indentationUnit = get_indentation_unit(document, leadingWhitespace);
	const continuationIndent = leadingWhitespace + indentationUnit.repeat(continuationIndentLevel);
	const firstLine = leadingWhitespace + renderedTokens.slice(0, openIndex + 1).join("");
	const declarationSuffix = `)${renderedTokens.slice(closeIndex + 1).join("")}`;
	const wrappedLines = [
		firstLine,
		...parameterTexts.map((parameterText, parameterIndex) => {
			const isLastParameter = parameterIndex === parameterTexts.length - 1;
			return `${continuationIndent}${parameterText}${isLastParameter ? declarationSuffix : ","}`;
		}),
	];

	return wrappedLines.some((wrappedLine) => wrappedLine.length > maxLineLength)
		? undefined
		: wrappedLines.join("\n");
}


/**
 * Wrap long additive expressions in assignments and return statements.
 * Preserve unary signs and leave ambiguous mixed expressions to specialized rules.
 */
function wrap_long_additive_expression(
	tokens: Token[],
	renderedTokens: string[],
	leadingWhitespace: string,
	currentLine: string,
	document: TextDocument,
	options: FormatterOptions,
): string | undefined {
	const maxLineLength = get_max_line_length(options);
	if (currentLine.length <= maxLineLength || tokens[0]?.string) return undefined;

	const firstValue = tokens[0]?.value ?? "";
	if (
		firstValue.startsWith("@") ||
		["class", "class_name", "elif", "enum", "extends", "for", "func", "if", "match", "signal", "while"].includes(
			firstValue,
		)
	) {
		return undefined;
	}
	if (
		tokens.some(
			(token) =>
				token.type === "comment" ||
				(!token.string &&
					(token.value === ";" ||
						(token.value.length === 1 && token.value.charCodeAt(0) === 92) ||
						token.value === "func")),
		)
	) {
		return undefined;
	}

	const assignmentOperators = new Set(["=", ":="]);
	const unsupportedTopLevelOperators = new Set([
		"and",
		"as",
		"else",
		"if",
		"in",
		"is",
		"not",
		"or",
		"!=",
		"<",
		"<=",
		"==",
		">",
		">=",
	]);
	const boundaryScan = scan_token_boundaries(tokens);
	const topLevelIndexes = boundaryScan.topLevelIndexes;
	const assignmentIndexes = topLevelIndexes.filter((tokenIndex) =>
		assignmentOperators.has(tokens[tokenIndex].value),
	);
	const additiveOperatorIndexes = topLevelIndexes.filter((tokenIndex) => {
		const currentToken = tokens[tokenIndex];
		if (currentToken.value !== "+" && currentToken.value !== "-") return false;

		const previousToken = tokens[tokenIndex - 1];
		return (
			previousToken !== undefined &&
			(previousToken.string === true ||
				(previousToken.identifier === true && previousToken.type !== "keyword") ||
				["bare_nodepath", "constant", "literal", "nodepath", "variable"].includes(previousToken.type ?? "") ||
				[")", "]", "}"].includes(previousToken.value))
		);
	});
	const hasUnsupportedTopLevelOperator = topLevelIndexes.some((tokenIndex) =>
		unsupportedTopLevelOperators.has(tokens[tokenIndex].value),
	);
	if (!boundaryScan.valid || hasUnsupportedTopLevelOperator) return undefined;

	if (firstValue === "return" && assignmentIndexes.length > 0) return undefined;
	if (firstValue !== "return" && assignmentIndexes.length !== 1) return undefined;
	const expressionStart = firstValue === "return" ? 1 : assignmentIndexes[0] + 1;
	const splitIndexes = additiveOperatorIndexes.filter((splitIndex) => splitIndex >= expressionStart);
	if (expressionStart <= 0 || splitIndexes.length === 0 || expressionStart >= splitIndexes[0]) {
		return undefined;
	}

	const segments = [...splitIndexes, tokens.length].map((endIndex, segmentIndex) => {
		const segmentStart = segmentIndex === 0 ? expressionStart : splitIndexes[segmentIndex - 1];
		return renderedTokens.slice(segmentStart, endIndex).join("").trim();
	});
	if (segments.some((segment) => segment.length === 0)) return undefined;

	const configuredIndentLevel = options.continuationIndentLevel;
	const continuationIndentLevel =
		typeof configuredIndentLevel === "number" && Number.isFinite(configuredIndentLevel)
			? Math.max(1, Math.min(4, Math.round(configuredIndentLevel)))
			: 2;
	const indentationUnit = get_indentation_unit(document, leadingWhitespace);
	const continuationIndent = leadingWhitespace + indentationUnit.repeat(continuationIndentLevel);
	const expressionPrefix =
		renderedTokens.slice(0, expressionStart).join("") + between(tokens, expressionStart, options);
	const firstLine = `${leadingWhitespace + expressionPrefix}(`;
	const wrappedLines = [
		firstLine,
		...segments.map((segment) => `${continuationIndent}${segment}`),
		`${leadingWhitespace})`,
	];

	return wrappedLines.some((wrappedLine) => wrappedLine.length > maxLineLength)
		? undefined
		: wrappedLines.join("\\n");
}

/**
 * Wrap an overlong property/method chain inside a parenthesized expression.
 * Safe argument and collection wrapping takes precedence; unsupported forms stay unchanged.
 */
function wrap_long_method_chain(
	tokens: Token[],
	renderedTokens: string[],
	leadingWhitespace: string,
	currentLine: string,
	document: TextDocument,
	options: FormatterOptions,
): string | undefined {
	const maxLineLength = get_max_line_length(options);
	if (currentLine.length <= maxLineLength || tokens[0]?.string) return undefined;

	const firstValue = tokens[0]?.value ?? "";
	if (
		firstValue.startsWith("@") ||
		[
			"assert",
			"break",
			"class",
			"class_name",
			"continue",
			"elif",
			"enum",
			"extends",
			"for",
			"func",
			"if",
			"match",
			"pass",
			"signal",
			"while",
		].includes(firstValue)
	) {
		return undefined;
	}
	if (
		tokens.some(
			(token) =>
				token.type === "comment" ||
				(!token.string &&
					(token.value === ";" ||
						(token.value.length === 1 && token.value.charCodeAt(0) === 92) ||
						token.value === "func")),
		)
	) {
		return undefined;
	}

	const assignmentOperators = new Set([
		"=",
		":=",
		"+=",
		"-=",
		"*=",
		"/=",
		"%=",
		"**=",
		"&=",
		"|=",
		"^=",
		"<<=",
		">>=",
	]);
	const boundaryScan = scan_token_boundaries(tokens);
	if (!boundaryScan.valid) return undefined;
	const topLevelDotIndexes = boundaryScan.topLevelIndexes.filter(
		(tokenIndex) => tokens[tokenIndex].value === ".",
	);
	const assignmentIndexes = boundaryScan.topLevelIndexes.filter((tokenIndex) =>
		assignmentOperators.has(tokens[tokenIndex].value),
	);

	const lastAssignmentIndex = assignmentIndexes.reduce(
		(currentLast, assignmentIndex) => Math.max(currentLast, assignmentIndex),
		-1,
	);
	if (["const", "static", "var"].includes(firstValue) && lastAssignmentIndex < 0) return undefined;
	const expressionStart =
		firstValue === "return" ? 1 : lastAssignmentIndex >= 0 ? lastAssignmentIndex + 1 : 0;
	const dotIndexes = topLevelDotIndexes.filter((dotIndex) => dotIndex >= expressionStart);
	if (
		dotIndexes.length === 0 ||
		dotIndexes.some((dotIndex) => !tokens[dotIndex - 1] || !tokens[dotIndex + 1])
	) {
		return undefined;
	}

	const segments = [...dotIndexes, tokens.length].map((endIndex, segmentIndex) => {
		const segmentStart = segmentIndex === 0 ? expressionStart : dotIndexes[segmentIndex - 1];
		return renderedTokens.slice(segmentStart, endIndex).join("").trim();
	});
	if (segments.length < 2 || segments.some((segment) => segment.length === 0)) return undefined;

	const expressionPrefix = renderedTokens.slice(0, expressionStart).join("").trimEnd();
	const firstLine = expressionPrefix ? `${leadingWhitespace}${expressionPrefix} (` : `${leadingWhitespace}(`;
	const configuredIndentLevel = options.continuationIndentLevel;
	const continuationIndentLevel =
		typeof configuredIndentLevel === "number" && Number.isFinite(configuredIndentLevel)
			? Math.max(1, Math.min(4, Math.round(configuredIndentLevel)))
			: 2;
	const indentationUnit = get_indentation_unit(document, leadingWhitespace);
	const continuationIndent = leadingWhitespace + indentationUnit.repeat(continuationIndentLevel);
	const wrappedLines = [
		firstLine,
		...segments.map((segment) => `${continuationIndent}${segment}`),
		`${leadingWhitespace})`,
	];

	return wrappedLines.some((wrappedLine) => wrappedLine.length > maxLineLength)
		? undefined
		: wrappedLines.join("\n");
}

