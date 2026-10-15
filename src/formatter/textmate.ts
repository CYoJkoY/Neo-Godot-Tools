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
			: 1;

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

type MultilineStringDelimiter = '"""' | "'''";

/** Recognize an unescaped multiline-string terminator within a lexical string token. */
function contains_unescaped_multiline_string_delimiter(
	text: string,
	delimiter: MultilineStringDelimiter,
): boolean {
	const pattern = delimiter === '"""' ? /(?<!\\)(?:\\\\)*"""/ : /(?<!\\)(?:\\\\)*'''/;
	return pattern.test(text);
}

/**
 * Carry multiline-string state across physical lines, using TextMate string scopes
 * so delimiters inside comments and ordinary strings do not open a multiline literal.
 */
function advance_multiline_string_delimiter(
	line: TextLine,
	tokenizedLine: vsctm.ITokenizeLineResult,
	activeDelimiter: MultilineStringDelimiter | undefined,
): MultilineStringDelimiter | undefined {
	return tokenizedLine.tokens.reduce((currentDelimiter, token) => {
		if (!token.scopes.includes("string.quoted.gdscript")) return currentDelimiter;

		const tokenText = line.text.slice(token.startIndex, token.endIndex);
		if (currentDelimiter) {
			return contains_unescaped_multiline_string_delimiter(tokenText, currentDelimiter)
				? undefined
				: currentDelimiter;
		}

		const openingDelimiter =
			tokenText.startsWith('"""') || tokenText.startsWith('r"""')
				? '"""'
				: tokenText.startsWith("'''") || tokenText.startsWith("r'''")
					? "'''"
					: undefined;
		if (!openingDelimiter) return currentDelimiter;

		const openingOffset = tokenText.startsWith("r") ? 1 : 0;
		const openingEnd = openingOffset + openingDelimiter.length;
		return contains_unescaped_multiline_string_delimiter(tokenText.slice(openingEnd), openingDelimiter)
			? undefined
			: openingDelimiter;
	}, activeDelimiter);
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

function get_editor_tab_size(document: TextDocument): number {
	const rawTabSize = vscode.workspace.getConfiguration("editor", document.uri).get<number>("tabSize", 4);
	return typeof rawTabSize === "number" && Number.isFinite(rawTabSize)
		? Math.max(1, Math.min(8, Math.round(rawTabSize)))
		: 4;
}

/** Measure line columns while expanding tabs to the next configured editor tab stop. */
function get_line_width(text: string, tabSize: number): number {
	return text.split("\t").reduce((column, segment, segmentIndex, segments) => {
		const segmentEndColumn = column + segment.length;
		return segmentIndex < segments.length - 1
			? segmentEndColumn + tabSize - (segmentEndColumn % tabSize)
			: segmentEndColumn;
	}, 0);
}

function get_indentation_unit(document: TextDocument, leadingWhitespace: string, configuredTabSize?: number): string {
	const editorConfiguration = vscode.workspace.getConfiguration("editor", document.uri);
	const tabSize = configuredTabSize ?? get_editor_tab_size(document);
	const configuredInsertSpaces = editorConfiguration.get<boolean>("insertSpaces", false);
	const indentationSample =
		leadingWhitespace.length > 0 ? leadingWhitespace : (document.getText().match(/^[ \t]+(?=\S)/m)?.[0] ?? "");
	const hasSpaceIndent = indentationSample.includes(" ");
	const hasTabIndent = indentationSample.includes("\t");
	const insertSpaces = hasSpaceIndent !== hasTabIndent ? hasSpaceIndent : configuredInsertSpaces;
	return insertSpaces ? " ".repeat(tabSize) : "\t";
}

interface InlineIndentContext {
	baseIndentation: string;
	extraLevels: number;
	indentationUnit: string;
}

/** Apply the indentation offset introduced when inline block suites expand. */
function apply_inline_indent_contexts(
	sourceLeadingWhitespace: string,
	contexts: InlineIndentContext[],
): string {
	const innermostContextIndex = contexts.reduce(
		(index, context, contextIndex) =>
			sourceLeadingWhitespace.length > context.baseIndentation.length &&
			sourceLeadingWhitespace.startsWith(context.baseIndentation)
				? contextIndex
				: index,
		-1,
	);
	contexts.splice(innermostContextIndex + 1);
	return (
		sourceLeadingWhitespace +
		contexts.reduce(
			(indentation, context) =>
				indentation + context.indentationUnit.repeat(context.extraLevels),
			"",
		)
	);
}

/**
 * Wrap a long boolean operand around safe top-level arithmetic or comparison operators.
 * The source operator tokens stay attached to their right-hand segments, preserving order.
 */
function wrap_long_boolean_term_expression(
	tokens: Token[],
	renderedTokens: string[],
	termRange: { startIndex: number; endIndex: number },
	continuationIndent: string,
	maxLineLength: number,
	indentationUnit: string,
	continuationIndentLevel: number,
	tabSize: number,
): string[] | undefined {
	const logicalOperator = ["and", "or"].includes(tokens[termRange.startIndex]?.value ?? "")
		? tokens[termRange.startIndex].value
		: undefined;
	const expressionStart = termRange.startIndex + (logicalOperator ? 1 : 0);
	const expressionScan = scan_token_boundaries(tokens, expressionStart, termRange.endIndex);
	if (!expressionScan.valid) return undefined;

	const unsupportedOperators = new Set([
		"and",
		"as",
		"else",
		"if",
		"in",
		"is",
		"not",
		"or",
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
		"&&",
		"||",
		";",
		"\\",
	]);
	if (
		expressionScan.topLevelIndexes.some((tokenIndex) =>
			unsupportedOperators.has(tokens[tokenIndex].value),
		)
	) {
		return undefined;
	}

	const comparisonIndexes = expressionScan.topLevelIndexes.filter((tokenIndex) =>
		comparisonOperatorValues.has(tokens[tokenIndex].value),
	);
	if (
		comparisonIndexes.length > 0 &&
		!has_valid_comparison_operands(tokens, comparisonIndexes, termRange.endIndex)
	) {
		return undefined;
	}

	const binaryOperatorValues = new Set(["+", "-", "*", "/", "%", "**", "&", "|", "^", "<<", ">>"]);
	const binaryIndexes = expressionScan.topLevelIndexes.filter((tokenIndex) => {
		const currentToken = tokens[tokenIndex];
		if (!binaryOperatorValues.has(currentToken.value)) return false;

		const previousToken = tokens[tokenIndex - 1];
		return (
			previousToken !== undefined &&
			(previousToken.string === true ||
				(previousToken.identifier === true && previousToken.type !== "keyword") ||
				["bare_nodepath", "constant", "literal", "nodepath", "variable"].includes(previousToken.type ?? "") ||
				[")", "]", "}"].includes(previousToken.value))
		);
	});
	const splitIndexes = [...comparisonIndexes, ...binaryIndexes].sort((left, right) => left - right);
	if (splitIndexes.length === 0) return undefined;

	const segmentRanges = [...splitIndexes, termRange.endIndex].map((endIndex, segmentIndex) => ({
		startIndex: segmentIndex === 0 ? expressionStart : splitIndexes[segmentIndex - 1],
		endIndex,
	}));
	if (
		segmentRanges.some(
			({ startIndex, endIndex }) =>
				renderedTokens.slice(startIndex, endIndex).join("").trim().length === 0,
		)
	) {
		return undefined;
	}

	const logicalPrefix = logicalOperator ? `${logicalOperator} ` : "";
	const firstLine = `${continuationIndent}${logicalPrefix}(`;
	const nestedIndent = continuationIndent + indentationUnit.repeat(continuationIndentLevel);
	const wrappedSegments = segmentRanges.reduce<string[][] | undefined>((groups, segmentRange) => {
		if (!groups) return undefined;

		const segment = renderedTokens.slice(segmentRange.startIndex, segmentRange.endIndex).join("").trim();
		const singleLine = `${nestedIndent}${segment}`;
		if (get_line_width(singleLine, tabSize) <= maxLineLength) {
			groups.push([singleLine]);
			return groups;
		}

		const nestedLines = wrap_function_call_range(
			tokens,
			renderedTokens,
			segmentRange.startIndex,
			segmentRange.endIndex,
			nestedIndent,
			"",
			maxLineLength,
			indentationUnit,
			continuationIndentLevel,
			tabSize,
		);
		if (!nestedLines || nestedLines.some((wrappedLine) => get_line_width(wrappedLine, tabSize) > maxLineLength)) {
			return undefined;
		}
		groups.push(nestedLines);
		return groups;
	}, []);
	if (!wrappedSegments) return undefined;

	const wrappedLines = [firstLine, ...wrappedSegments.flat(), `${continuationIndent})`];
	return wrappedLines.every((wrappedLine) => get_line_width(wrappedLine, tabSize) <= maxLineLength)
		? wrappedLines
		: undefined;
}

function wrap_long_boolean_condition(
	tokens: Token[],
	renderedTokens: string[],
	leadingWhitespace: string,
	document: TextDocument,
	options: FormatterOptions,
	tabSize: number,
	currentLineWidth: number,
): string | undefined {
	const maxLineLength = get_max_line_length(options);
	if (currentLineWidth <= maxLineLength) return undefined;

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

	const termRanges = [...splitIndexes, endIndex].map((endIndex, termIndex) => ({
		startIndex: termIndex === 0 ? 1 : splitIndexes[termIndex - 1],
		endIndex,
	}));
	if (
		termRanges.some(
			({ startIndex, endIndex }) =>
				renderedTokens.slice(startIndex, endIndex).join("").trim().length === 0,
		)
	) {
		return undefined;
	}

	const configuredIndentLevel = options.continuationIndentLevel;
	const continuationIndentLevel =
		typeof configuredIndentLevel === "number" && Number.isFinite(configuredIndentLevel)
			? Math.max(1, Math.min(4, Math.round(configuredIndentLevel)))
			: 1;
	const indentationUnit = get_indentation_unit(document, leadingWhitespace, tabSize);
	const continuationIndent = leadingWhitespace + indentationUnit.repeat(continuationIndentLevel);
	const wrappedTermGroups = termRanges.reduce<string[][] | undefined>((groups, termRange) => {
		if (!groups) return undefined;

		const term = renderedTokens.slice(termRange.startIndex, termRange.endIndex).join("").trim();
		const singleLine = continuationIndent + term;
		if (get_line_width(singleLine, tabSize) <= maxLineLength) {
			groups.push([singleLine]);
			return groups;
		}

		const nestedLines = wrap_function_call_range(
			tokens,
			renderedTokens,
			termRange.startIndex,
			termRange.endIndex,
			continuationIndent,
			"",
			maxLineLength,
			indentationUnit,
			continuationIndentLevel,
			tabSize,
		);
		if (nestedLines?.every((wrappedLine) => get_line_width(wrappedLine, tabSize) <= maxLineLength)) {
			groups.push(nestedLines);
			return groups;
		}

		const expressionLines = wrap_long_boolean_term_expression(
			tokens,
			renderedTokens,
			termRange,
			continuationIndent,
			maxLineLength,
			indentationUnit,
			continuationIndentLevel,
			tabSize,
		);
		if (!expressionLines) return undefined;
		groups.push(expressionLines);
		return groups;
	}, []);

	if (!wrappedTermGroups) return undefined;

	const wrappedLines = [
		`${leadingWhitespace}${renderedTokens[0].trim()} (`,
		...wrappedTermGroups.flat(),
		`${leadingWhitespace}):`,
	];
	return wrappedLines.every((wrappedLine) => get_line_width(wrappedLine, tabSize) <= maxLineLength)
		? wrappedLines.join("\n")
		: undefined;
}

/**
 * Keep a short single-argument call intact when the assignment target alone makes its line too long.
 * Parenthesize the right-hand side instead of unnecessarily splitting the call's argument layout.
 */
function wrap_long_assignment_call_expression(
	tokens: Token[],
	renderedTokens: string[],
	leadingWhitespace: string,
	document: TextDocument,
	options: FormatterOptions,
	tabSize: number,
	currentLineWidth: number,
): string | undefined {
	const maxLineLength = get_max_line_length(options);
	if (currentLineWidth <= maxLineLength || tokens[0]?.string) return undefined;

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
	const assignmentIndexes = boundaryScan.topLevelIndexes.filter((tokenIndex) =>
		assignmentOperators.has(tokens[tokenIndex].value),
	);
	if (assignmentIndexes.length !== 1) return undefined;

	const expressionStart = assignmentIndexes[0] + 1;
	if (expressionStart >= tokens.length) return undefined;
	const matchingCall = [...boundaryScan.matchingClosers.entries()].find(
		([openIndex, closeIndex]) =>
			openIndex >= expressionStart &&
			tokens[openIndex]?.value === "(" &&
			closeIndex === tokens.length - 1,
	);
	if (!matchingCall) return undefined;

	const [openIndex, closeIndex] = matchingCall;
	const unsupportedExpressionOperators = new Set([
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
		"+",
		"-",
		"*",
		"/",
		"%",
		"**",
		"&",
		"|",
		"^",
		"<<",
		">>",
	]);
	if (
		boundaryScan.topLevelIndexes.some(
			(tokenIndex) =>
				tokenIndex >= expressionStart &&
				tokenIndex < openIndex &&
				unsupportedExpressionOperators.has(tokens[tokenIndex].value),
		)
	) {
		return undefined;
	}
	const callableToken = tokens[openIndex - 1];
	const isCallable =
		callableToken !== undefined &&
		!callableToken.string &&
		((callableToken.identifier === true &&
			(callableToken.type !== "keyword" || ["assert", "yield"].includes(callableToken.value))) ||
			[")", "]"].includes(callableToken.value));
	if (!isCallable) return undefined;

	const argumentScan = scan_token_boundaries(tokens, openIndex + 1, closeIndex);
	if (!argumentScan.valid) return undefined;
	const commaIndexes = argumentScan.topLevelIndexes.filter((tokenIndex) => tokens[tokenIndex].value === ",");
	if (commaIndexes.length > 1 || (commaIndexes.length === 1 && commaIndexes[0] !== closeIndex - 1)) {
		return undefined;
	}
	const argumentEndIndex = commaIndexes[0] ?? closeIndex;
	if (renderedTokens.slice(openIndex + 1, argumentEndIndex).join("").trim().length === 0) {
		return undefined;
	}

	const expression = renderedTokens.slice(expressionStart).join("").trim();
	// If the complete RHS call fits on its own, do not split it just because
	// a long identifier or type annotation makes the assignment line exceed the limit.
	if (get_line_width(expression, tabSize) <= maxLineLength) {
		return leadingWhitespace + renderedTokens.join("");
	}

	const configuredIndentLevel = options.continuationIndentLevel;
	const continuationIndentLevel =
		typeof configuredIndentLevel === "number" && Number.isFinite(configuredIndentLevel)
			? Math.max(1, Math.min(4, Math.round(configuredIndentLevel)))
			: 1;
	const indentationUnit = get_indentation_unit(document, leadingWhitespace, tabSize);
	const continuationIndent = leadingWhitespace + indentationUnit.repeat(continuationIndentLevel);
	const expressionPrefix =
		renderedTokens.slice(0, expressionStart).join("") + between(tokens, expressionStart, options);
	const wrappedLines = [
		`${leadingWhitespace + expressionPrefix}(`,
		`${continuationIndent}${expression}`,
		`${leadingWhitespace})`,
	];

	return wrappedLines.some((wrappedLine) => get_line_width(wrappedLine, tabSize) > maxLineLength)
		? undefined
		: wrappedLines.join("\n");
}


/**
 * Wrap a long single-line function call when top-level argument commas provide
 * safe split points. Unsupported shapes remain untouched.
 */
function wrap_long_function_call(
	tokens: Token[],
	renderedTokens: string[],
	leadingWhitespace: string,
	document: TextDocument,
	options: FormatterOptions,
	tabSize: number,
	currentLineWidth: number,
): string | undefined {
	const maxLineLength = get_max_line_length(options);
	if (currentLineWidth <= maxLineLength || tokens[0]?.string) return undefined;

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

	const indentationUnit = get_indentation_unit(document, leadingWhitespace, tabSize);
	const configuredIndentLevel = options.continuationIndentLevel;
	const continuationIndentLevel =
		typeof configuredIndentLevel === "number" && Number.isFinite(configuredIndentLevel)
			? Math.max(1, Math.min(4, Math.round(configuredIndentLevel)))
			: 1;
	const wrappedLines = wrap_function_call_range(
		tokens,
		renderedTokens,
		0,
		tokens.length,
		leadingWhitespace,
		"",
		maxLineLength,
		indentationUnit,
		continuationIndentLevel,
		tabSize,
	);
	return wrappedLines?.join("\n");
}


/**
 * Wraps one validated call within a token range, recursively laying out long nested arguments.
 * All slices use the source token indexes so operators, delimiters, and suffixes stay ordered.
 */
function wrap_function_call_range(
	tokens: Token[],
	renderedTokens: string[],
	rangeStart: number,
	rangeEnd: number,
	leadingWhitespace: string,
	trailingSuffix: string,
	maxLineLength: number,
	indentationUnit: string,
	continuationIndentLevel: number,
	tabSize: number,
): string[] | undefined {
	const boundaryScan = scan_token_boundaries(tokens, rangeStart, rangeEnd);
	if (!boundaryScan.valid) return undefined;

	return [...boundaryScan.matchingClosers.entries()]
		.filter(
			([openIndex, closeIndex]) =>
				openIndex >= rangeStart &&
				closeIndex < rangeEnd &&
				tokens[openIndex]?.value === "(",
		)
		.sort((leftPair, rightPair) => leftPair[0] - rightPair[0])
		.reduce<string[] | undefined>(
			(wrappedLines, [openIndex, closeIndex]) =>
				wrappedLines ??
				wrap_function_call_candidate(
					tokens,
					renderedTokens,
					rangeStart,
					rangeEnd,
					openIndex,
					closeIndex,
					leadingWhitespace,
					trailingSuffix,
					maxLineLength,
					indentationUnit,
					continuationIndentLevel,
					tabSize,
				),
			undefined,
		);
}


/** Render one candidate call and recursively wrap only argument lines that need it. */
function wrap_function_call_candidate(
	tokens: Token[],
	renderedTokens: string[],
	rangeStart: number,
	rangeEnd: number,
	openIndex: number,
	closeIndex: number,
	leadingWhitespace: string,
	trailingSuffix: string,
	maxLineLength: number,
	indentationUnit: string,
	continuationIndentLevel: number,
	tabSize: number,
): string[] | undefined {
	const callableToken = tokens[openIndex - 1];
	const isCallable =
		callableToken !== undefined &&
		!callableToken.string &&
		((callableToken.identifier === true &&
			(callableToken.type !== "keyword" || ["assert", "yield"].includes(callableToken.value))) ||
			[")", "]"].includes(callableToken.value));
	if (!isCallable) return undefined;

	const argumentScan = scan_token_boundaries(tokens, openIndex + 1, closeIndex);
	if (!argumentScan.valid) return undefined;
	const commaIndexes = argumentScan.topLevelIndexes.filter(
		(tokenIndex) => tokens[tokenIndex].value === ",",
	);
	const trailingCommaIndex = commaIndexes[commaIndexes.length - 1];
	const hasTrailingComma = trailingCommaIndex === closeIndex - 1;
	const argumentSeparatorIndexes = hasTrailingComma ? commaIndexes.slice(0, -1) : commaIndexes;
	const finalArgumentEndIndex = hasTrailingComma ? trailingCommaIndex : closeIndex;
	const argumentRanges = [...argumentSeparatorIndexes, finalArgumentEndIndex].map((endIndex, argumentIndex) => ({
		startIndex:
			argumentIndex === 0 ? openIndex + 1 : argumentSeparatorIndexes[argumentIndex - 1] + 1,
		endIndex,
		isLastArgument: argumentIndex === argumentSeparatorIndexes.length,
	}));
	if (
		argumentRanges.some(
			({ startIndex, endIndex }) =>
				renderedTokens.slice(startIndex, endIndex).join("").trim().length === 0,
		)
	) {
		return undefined;
	}

	const prefix = renderedTokens.slice(rangeStart, openIndex + 1).join("");
	const suffix = renderedTokens.slice(closeIndex + 1, rangeEnd).join("") + trailingSuffix;
	const firstLine = leadingWhitespace + prefix;
	if (get_line_width(firstLine, tabSize) > maxLineLength) return undefined;

	const continuationIndent = leadingWhitespace + indentationUnit.repeat(continuationIndentLevel);
	const argumentLines = argumentRanges.reduce(
		(state, argumentRange) => {
			if (!state.valid) return state;

			const argumentText = renderedTokens
				.slice(argumentRange.startIndex, argumentRange.endIndex)
				.join("")
				.trim();
			const separator = argumentRange.isLastArgument ? (hasTrailingComma ? "," : "") : ",";
			const singleLine = continuationIndent + argumentText + separator;
			if (get_line_width(singleLine, tabSize) <= maxLineLength) {
				state.lines.push(singleLine);
				return state;
			}

			const nestedLines =
				wrap_function_call_range(
					tokens,
					renderedTokens,
					argumentRange.startIndex,
					argumentRange.endIndex,
					continuationIndent,
					separator,
					maxLineLength,
					indentationUnit,
					continuationIndentLevel,
					tabSize,
				) ??
				wrap_collection_range(
					tokens,
					renderedTokens,
					argumentRange.startIndex,
					argumentRange.endIndex,
					continuationIndent,
					separator,
					maxLineLength,
					indentationUnit,
					continuationIndentLevel,
					tabSize,
				) ??
				wrap_long_binary_expression_range(
					tokens,
					renderedTokens,
					argumentRange.startIndex,
					argumentRange.endIndex,
					continuationIndent,
					separator,
					maxLineLength,
					indentationUnit,
					continuationIndentLevel,
					tabSize,
				);
			if (!nestedLines || nestedLines.some((wrappedLine) => get_line_width(wrappedLine, tabSize) > maxLineLength)) {
				state.valid = false;
				return state;
			}
			state.lines.push(...nestedLines);
			return state;
		},
		{ valid: true, lines: [] as string[] },
	);
	if (!argumentLines.valid) return undefined;

	const closingLine = `${leadingWhitespace})${suffix}`;
	const wrappedLines = [firstLine, ...argumentLines.lines, closingLine];
	return wrappedLines.some((wrappedLine) => get_line_width(wrappedLine, tabSize) > maxLineLength)
		? undefined
		: wrappedLines;
}


/**
 * Wrap a dictionary entry when its value contains a long, safely splittable function call.
 * The entry prefix is retained on the call's first line; ambiguous key/value shapes are skipped.
 */
function wrap_long_dictionary_entry_value(
	tokens: Token[],
	renderedTokens: string[],
	rangeStart: number,
	rangeEnd: number,
	leadingWhitespace: string,
	trailingSuffix: string,
	maxLineLength: number,
	indentationUnit: string,
	continuationIndentLevel: number,
	tabSize: number,
): string[] | undefined {
	const entryScan = scan_token_boundaries(tokens, rangeStart, rangeEnd);
	if (!entryScan.valid) return undefined;
	const separators = entryScan.topLevelIndexes.filter(
		(tokenIndex) => tokens[tokenIndex].value === ":",
	);
	if (separators.length !== 1 || separators[0] <= rangeStart || separators[0] >= rangeEnd - 1) {
		return undefined;
	}

	const valueStart = separators[0] + 1;
	const valueScan = scan_token_boundaries(tokens, valueStart, rangeEnd);
	if (!valueScan.valid) return undefined;

	return [...valueScan.matchingClosers.entries()]
		.filter(
			([openIndex, closeIndex]) =>
				openIndex >= valueStart &&
				closeIndex < rangeEnd &&
				tokens[openIndex]?.value === "(",
		)
		.sort((leftPair, rightPair) => leftPair[0] - rightPair[0])
		.reduce<string[] | undefined>(
			(wrappedLines, [openIndex, closeIndex]) =>
				wrappedLines ??
				wrap_function_call_candidate(
					tokens,
					renderedTokens,
					rangeStart,
					rangeEnd,
					openIndex,
					closeIndex,
					leadingWhitespace,
					trailingSuffix,
					maxLineLength,
					indentationUnit,
					continuationIndentLevel,
					tabSize,
				),
			undefined,
		);
}


/**
 * Wrap clear top-level ternary branches in a dictionary value without moving the key or colon.
 * Only complete alternating if/else sequences are eligible.
 */
function wrap_long_dictionary_entry_ternary_value(
	tokens: Token[],
	renderedTokens: string[],
	rangeStart: number,
	rangeEnd: number,
	leadingWhitespace: string,
	trailingSuffix: string,
	maxLineLength: number,
	indentationUnit: string,
	continuationIndentLevel: number,
	tabSize: number,
): string[] | undefined {
	const entryScan = scan_token_boundaries(tokens, rangeStart, rangeEnd);
	if (!entryScan.valid) return undefined;

	const separators = entryScan.topLevelIndexes.filter(
		(tokenIndex) => tokens[tokenIndex].value === ":",
	);
	if (separators.length !== 1 || separators[0] <= rangeStart || separators[0] >= rangeEnd - 1) {
		return undefined;
	}

	const valueStart = separators[0] + 1;
	const valueScan = scan_token_boundaries(tokens, valueStart, rangeEnd);
	if (!valueScan.valid) return undefined;

	const valueTokens = tokens.slice(valueStart, rangeEnd);
	if (
		valueTokens.some(
			(token) =>
				token.type === "comment" ||
				(!token.string &&
					(token.value === "func" ||
						token.value === ";" ||
						token.value === "=" ||
						token.value === ":=" ||
						(token.value.length === 1 && token.value.charCodeAt(0) === 92))),
		)
	) {
		return undefined;
	}

	const markers = valueScan.topLevelIndexes.flatMap((tokenIndex) => {
		const value = tokens[tokenIndex].value;
		return value === "if" || value === "else" ? [{ index: tokenIndex, value }] : [];
	});
	const markerSequenceIsValid =
		markers.length >= 2 &&
		markers.length % 2 === 0 &&
		markers.every((marker, markerIndex) => marker.value === (markerIndex % 2 === 0 ? "if" : "else"));
	if (!markerSequenceIsValid) return undefined;

	const branchesAreComplete = markers
		.filter((_, markerIndex) => markerIndex % 2 === 0)
		.every((ifMarker, pairIndex) => {
			const elseMarker = markers[pairIndex * 2 + 1];
			const branchStart = pairIndex === 0 ? valueStart : markers[pairIndex * 2 - 1].index + 1;
			return (
				ifMarker.index > branchStart &&
				elseMarker.index > ifMarker.index + 1 &&
				elseMarker.index < rangeEnd - 1
			);
		});
	if (!branchesAreComplete) return undefined;

	const elseIndexes = markers
		.filter((marker) => marker.value === "else")
		.map((marker) => marker.index);
	const segments = [...elseIndexes, rangeEnd].map((endIndex, segmentIndex) => {
		const segmentStart = segmentIndex === 0 ? valueStart : elseIndexes[segmentIndex - 1];
		return renderedTokens.slice(segmentStart, endIndex).join("").trim();
	});
	if (segments.some((segment) => segment.length === 0)) return undefined;

	const expressionPrefix = renderedTokens.slice(rangeStart, valueStart).join("");
	const valueSpacing = renderedTokens[valueStart].match(/^\\s*/)?.[0] ?? "";
	const firstLine = `${leadingWhitespace + expressionPrefix}${valueSpacing}(`;
	const continuationIndent = leadingWhitespace + indentationUnit.repeat(continuationIndentLevel);
	const closingLine = `${leadingWhitespace})${trailingSuffix}`;
	const wrappedLines = [
		firstLine,
		...segments.map((segment) => `${continuationIndent}${segment}`),
		closingLine,
	];
	return wrappedLines.some((wrappedLine) => get_line_width(wrappedLine, tabSize) > maxLineLength)
		? undefined
		: wrappedLines;
}


/**
 * Wrap a dictionary value's top-level arithmetic and bitwise operators without altering the key or colon.
 * Unary operators and operators nested inside delimiters are not split points.
 */
function wrap_long_dictionary_entry_binary_value(
	tokens: Token[],
	renderedTokens: string[],
	rangeStart: number,
	rangeEnd: number,
	leadingWhitespace: string,
	trailingSuffix: string,
	maxLineLength: number,
	indentationUnit: string,
	continuationIndentLevel: number,
	tabSize: number,
): string[] | undefined {
	const entryScan = scan_token_boundaries(tokens, rangeStart, rangeEnd);
	if (!entryScan.valid) return undefined;
	const separators = entryScan.topLevelIndexes.filter(
		(tokenIndex) => tokens[tokenIndex].value === ":",
	);
	if (separators.length !== 1 || separators[0] <= rangeStart || separators[0] >= rangeEnd - 1) {
		return undefined;
	}

	const valueStart = separators[0] + 1;
	const valueScan = scan_token_boundaries(tokens, valueStart, rangeEnd);
	if (!valueScan.valid) return undefined;
	if (
		tokens.slice(valueStart, rangeEnd).some(
			(token) =>
				token.type === "comment" ||
				(!token.string && (token.value === ";" || (token.value.length === 1 && token.value.charCodeAt(0) === 92))),
		)
	) {
		return undefined;
	}

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
		"=",
		":=",
	]);
	if (valueScan.topLevelIndexes.some((tokenIndex) => unsupportedTopLevelOperators.has(tokens[tokenIndex].value))) {
		return undefined;
	}

	const binaryOperatorValues = new Set(["+", "-", "*", "/", "%", "**", "&", "|", "^", "<<", ">>"]);
	const splitIndexes = valueScan.topLevelIndexes.filter((tokenIndex) => {
		const currentToken = tokens[tokenIndex];
		if (!binaryOperatorValues.has(currentToken.value)) return false;
		const previousToken = tokens[tokenIndex - 1];
		return (
			previousToken !== undefined &&
			(previousToken.string === true ||
				(previousToken.identifier === true && previousToken.type !== "keyword") ||
				["bare_nodepath", "constant", "literal", "nodepath", "variable"].includes(previousToken.type ?? "") ||
				[")", "]", "}"].includes(previousToken.value))
		);
	});
	if (splitIndexes.length === 0 || splitIndexes[0] <= valueStart) return undefined;

	const segments = [...splitIndexes, rangeEnd].map((endIndex, segmentIndex) => {
		const segmentStart = segmentIndex === 0 ? valueStart : splitIndexes[segmentIndex - 1];
		return renderedTokens.slice(segmentStart, endIndex).join("").trim();
	});
	if (segments.some((segment) => segment.length === 0)) return undefined;

	const expressionPrefix = renderedTokens.slice(rangeStart, valueStart).join("");
	const valueSpacing = renderedTokens[valueStart].match(/^\s*/)?.[0] ?? "";
	const firstLine = `${leadingWhitespace + expressionPrefix}${valueSpacing}(`;
	const continuationIndent = leadingWhitespace + indentationUnit.repeat(continuationIndentLevel);
	const closingLine = `${leadingWhitespace})${trailingSuffix}`;
	const wrappedLines = [
		firstLine,
		...segments.map((segment) => `${continuationIndent}${segment}`),
		closingLine,
	];
	return wrappedLines.some((wrappedLine) => get_line_width(wrappedLine, tabSize) > maxLineLength)
		? undefined
		: wrappedLines;
}


/**
 * Wrap top-level arithmetic, bitwise, and shift operators in an expression range.
 * Parentheses preserve precedence, while unsupported expression forms remain unchanged.
 */
function wrap_long_binary_expression_range(
	tokens: Token[],
	renderedTokens: string[],
	rangeStart: number,
	rangeEnd: number,
	leadingWhitespace: string,
	trailingSuffix: string,
	maxLineLength: number,
	indentationUnit: string,
	continuationIndentLevel: number,
	tabSize: number,
): string[] | undefined {
	const memberScan = scan_token_boundaries(tokens, rangeStart, rangeEnd);
	if (!memberScan.valid) return undefined;
	if (
		tokens.slice(rangeStart, rangeEnd).some(
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
		"&&",
		"||",
		"~=",
	]);
	if (
		memberScan.topLevelIndexes.some((tokenIndex) =>
			unsupportedTopLevelOperators.has(tokens[tokenIndex].value),
		)
	) {
		return undefined;
	}

	const binaryOperatorValues = new Set(["+", "-", "*", "/", "%", "**", "&", "|", "^", "<<", ">>"]);
	const splitIndexes = memberScan.topLevelIndexes.filter((tokenIndex) => {
		const currentToken = tokens[tokenIndex];
		if (tokenIndex <= rangeStart || !binaryOperatorValues.has(currentToken.value)) return false;
		const previousToken = tokens[tokenIndex - 1];
		return (
			previousToken !== undefined &&
			(previousToken.string === true ||
				(previousToken.identifier === true && previousToken.type !== "keyword") ||
				["bare_nodepath", "constant", "literal", "nodepath", "variable"].includes(previousToken.type ?? "") ||
				[")", "]", "}"].includes(previousToken.value))
		);
	});
	if (splitIndexes.length === 0) return undefined;

	const segments = [...splitIndexes, rangeEnd].map((endIndex, segmentIndex) => {
		const segmentStart = segmentIndex === 0 ? rangeStart : splitIndexes[segmentIndex - 1];
		return renderedTokens.slice(segmentStart, endIndex).join("").trim();
	});
	if (segments.some((segment) => segment.length === 0)) return undefined;

	const firstLine = `${leadingWhitespace}(`;
	const continuationIndent = leadingWhitespace + indentationUnit.repeat(continuationIndentLevel);
	const closingLine = `${leadingWhitespace})${trailingSuffix}`;
	const wrappedLines = [
		firstLine,
		...segments.map((segment) => `${continuationIndent}${segment}`),
		closingLine,
	];
	return wrappedLines.some((wrappedLine) => get_line_width(wrappedLine, tabSize) > maxLineLength)
		? undefined
		: wrappedLines;
}


const dictionaryBooleanOperatorValues = new Set(["and", "or"]);
const comparisonOperatorValues = new Set(["==", "!=", "<", "<=", ">", ">="]);
const comparisonOperandPrefixValues = new Set(["+", "-", "!", "~", "not", "await"]);
const comparisonIncompleteExpressionValues = new Set([
	"!=",
	"<",
	"<=",
	"==",
	">",
	">=",
	"and",
	"as",
	"else",
	"if",
	"in",
	"is",
	"not",
	"or",
	"=",
	":=",
	"+",
	"-",
	"*",
	"/",
	"%",
	"**",
	"<<",
	">>",
	"&",
	"|",
	"^",
	"&&",
	"||",
	".",
	",",
	":",
]);

/**
 * Verify comparison operands are present before introducing line breaks at symbolic comparisons.
 */
function has_valid_comparison_operands(
	tokens: Token[],
	splitIndexes: number[],
	rangeEnd: number,
): boolean {
	return splitIndexes.every((operatorIndex, operatorPosition) => {
		const leftOperandEnd = tokens[operatorIndex - 1];
		const rightSegmentEnd = splitIndexes[operatorPosition + 1] ?? rangeEnd;
		const rightOperandEnd = tokens[rightSegmentEnd - 1];
		if (
			!leftOperandEnd ||
			!rightOperandEnd ||
			comparisonIncompleteExpressionValues.has(leftOperandEnd.value) ||
			comparisonIncompleteExpressionValues.has(rightOperandEnd.value)
		) {
			return false;
		}

		const rightOperandTokens = tokens.slice(operatorIndex + 1, rightSegmentEnd);
		const firstOperandIndex = rightOperandTokens.findIndex(
			(token) => !comparisonOperandPrefixValues.has(token.value),
		);
		if (firstOperandIndex < 0) return false;

		const firstOperandToken = rightOperandTokens[firstOperandIndex];
		return (
			!comparisonOperatorValues.has(firstOperandToken.value) &&
			!["and", "or", "if", "else", "=", ":=", ".", ",", ":"].includes(firstOperandToken.value)
		);
	});
}

/**
 * Wrap top-level operators in a dictionary value without changing its key or colon.
 * Strings, nested delimiters, ternaries, and unsupported expression forms remain unchanged.
 */
function wrap_long_dictionary_entry_operator_value(
	tokens: Token[],
	renderedTokens: string[],
	rangeStart: number,
	rangeEnd: number,
	leadingWhitespace: string,
	trailingSuffix: string,
	maxLineLength: number,
	indentationUnit: string,
	continuationIndentLevel: number,
	splitOperatorValues: ReadonlySet<string>,
	operatorKind: "boolean" | "comparison",
	tabSize: number,
): string[] | undefined {
	const entryScan = scan_token_boundaries(tokens, rangeStart, rangeEnd);
	if (!entryScan.valid) return undefined;
	const separators = entryScan.topLevelIndexes.filter(
		(tokenIndex) => tokens[tokenIndex].value === ":",
	);
	if (separators.length !== 1 || separators[0] <= rangeStart || separators[0] >= rangeEnd - 1) {
		return undefined;
	}

	const valueStart = separators[0] + 1;
	const valueScan = scan_token_boundaries(tokens, valueStart, rangeEnd);
	if (!valueScan.valid) return undefined;
	if (
		tokens.slice(valueStart, rangeEnd).some(
			(token) =>
				token.type === "comment" ||
				(!token.string && (token.value === ";" || (token.value.length === 1 && token.value.charCodeAt(0) === 92))),
		)
	) {
		return undefined;
	}

	const topLevelValues = valueScan.topLevelIndexes.map((tokenIndex) => tokens[tokenIndex].value);
	if (
		topLevelValues.some((value) => ["if", "else"].includes(value)) ||
		tokens.slice(valueStart, rangeEnd).some((token) => !token.string && token.value === "func")
	) {
		return undefined;
	}
	if (
		operatorKind === "comparison" &&
		topLevelValues.some((value) => ["and", "or", "&&", "||", "as", "in", "is", "not"].includes(value))
	) {
		return undefined;
	}

	const splitIndexes = valueScan.topLevelIndexes.filter((tokenIndex) =>
		splitOperatorValues.has(tokens[tokenIndex].value),
	);
	if (splitIndexes.length === 0 || splitIndexes[0] <= valueStart) return undefined;
	if (
		operatorKind === "comparison" &&
		!has_valid_comparison_operands(tokens, splitIndexes, rangeEnd)
	) {
		return undefined;
	}

	const segments = [...splitIndexes, rangeEnd].map((endIndex, segmentIndex) => {
		const segmentStart = segmentIndex === 0 ? valueStart : splitIndexes[segmentIndex - 1];
		return renderedTokens.slice(segmentStart, endIndex).join("").trim();
	});
	const segmentsAreValid = segments.every((segment, segmentIndex) => {
		const segmentText = segment.trim();
		if (!segmentText || (segmentIndex === 0 && operatorKind === "boolean" && segmentText === "not")) {
			return false;
		}
		if (segmentIndex === 0) return true;

		const leadingOperator = operatorKind === "boolean"
			? /^(and|or)\b/.exec(segmentText)
			: /^(==|!=|<=|>=|<|>)/.exec(segmentText);
		if (!leadingOperator) return false;
		const expressionText = segmentText.slice(leadingOperator[0].length).trim();
		if (operatorKind === "boolean") return expressionText.length > 0 && expressionText !== "not";
		return expressionText.length > 0;
	});
	if (!segmentsAreValid) return undefined;

	const expressionPrefix = renderedTokens.slice(rangeStart, valueStart).join("");
	const valueSpacing = renderedTokens[valueStart].match(/^\s*/)?.[0] ?? "";
	const firstLine = `${leadingWhitespace + expressionPrefix}${valueSpacing}(`;
	const continuationIndent = leadingWhitespace + indentationUnit.repeat(continuationIndentLevel);
	const closingLine = `${leadingWhitespace})${trailingSuffix}`;
	const wrappedLines = [
		firstLine,
		...segments.map((segment) => `${continuationIndent}${segment}`),
		closingLine,
	];
	return wrappedLines.some((wrappedLine) => get_line_width(wrappedLine, tabSize) > maxLineLength)
		? undefined
		: wrappedLines;
}

/** Wrap top-level `and` / `or` operators in a dictionary value. */
function wrap_long_dictionary_entry_boolean_value(
	tokens: Token[],
	renderedTokens: string[],
	rangeStart: number,
	rangeEnd: number,
	leadingWhitespace: string,
	trailingSuffix: string,
	maxLineLength: number,
	indentationUnit: string,
	continuationIndentLevel: number,
	tabSize: number,
): string[] | undefined {
	return wrap_long_dictionary_entry_operator_value(
		tokens,
		renderedTokens,
		rangeStart,
		rangeEnd,
		leadingWhitespace,
		trailingSuffix,
		maxLineLength,
		indentationUnit,
		continuationIndentLevel,
		dictionaryBooleanOperatorValues,
		"boolean",
		tabSize,
	);
}

/** Wrap top-level symbolic comparison operators in a dictionary value. */
function wrap_long_dictionary_entry_comparison_value(
	tokens: Token[],
	renderedTokens: string[],
	rangeStart: number,
	rangeEnd: number,
	leadingWhitespace: string,
	trailingSuffix: string,
	maxLineLength: number,
	indentationUnit: string,
	continuationIndentLevel: number,
	tabSize: number,
): string[] | undefined {
	return wrap_long_dictionary_entry_operator_value(
		tokens,
		renderedTokens,
		rangeStart,
		rangeEnd,
		leadingWhitespace,
		trailingSuffix,
		maxLineLength,
		indentationUnit,
		continuationIndentLevel,
		comparisonOperatorValues,
		"comparison",
		tabSize,
	);
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
	const scan = tokens.slice(startIndex, endIndex).reduce(
		(state, currentToken, offset) => {
			if (currentToken.string || currentToken.type === "comment" || !state.valid) return state;

			const tokenIndex = startIndex + offset;
			if (state.stack.length === 0) state.topLevelIndexes.push(tokenIndex);
			if (openingDelimiters.has(currentToken.value)) {
				state.stack.push({ index: tokenIndex, value: currentToken.value });
				return state;
			}

			const expectedOpening = closingDelimiters.get(currentToken.value);
			if (expectedOpening === undefined) return state;

			const openingToken = state.stack.pop();
			if (!openingToken || openingToken.value !== expectedOpening) {
				state.valid = false;
				return state;
			}
			state.matchingClosers.set(openingToken.index, tokenIndex);
			return state;
		},
		{
			valid: true,
			stack: [] as { index: number; value: string }[],
			topLevelIndexes: [] as number[],
			matchingClosers: new Map<number, number>(),
		},
	);
	return {
		valid: scan.valid && scan.stack.length === 0,
		topLevelIndexes: scan.topLevelIndexes,
		matchingClosers: scan.matchingClosers,
	};
}


/**
 * Normalize inline enum declarations to the GDScript style guide's one-member-per-line layout.
 * Unsupported or ambiguous enum forms remain unchanged.
 */
function format_inline_enum_declaration(
	tokens: Token[],
	renderedTokens: string[],
	leadingWhitespace: string,
	document: TextDocument,
	options: FormatterOptions,
	tabSize: number,
): string | undefined {
	if (tokens[0]?.value !== "enum" || tokens[0]?.string) return undefined;
	if (
		tokens.some(
			(token) =>
				token.type === "comment" ||
				(!token.string && (token.value === ";" || (token.value.length === 1 && token.value.charCodeAt(0) === 92))),
		)
	) {
		return undefined;
	}

	const delimiterScan = scan_token_boundaries(tokens);
	if (!delimiterScan.valid) return undefined;
	const enumName = tokens[1];
	const isNamedEnum =
		tokens[2]?.value === "{" &&
		enumName !== undefined &&
		!enumName.string &&
		enumName.type !== "keyword" &&
		/^[A-Za-z_]\w*$/.test(enumName.value);
	const openIndex = tokens[1]?.value === "{" ? 1 : isNamedEnum ? 2 : -1;
	if (openIndex < 0) return undefined;
	const closeIndex = delimiterScan.matchingClosers.get(openIndex) ?? -1;
	if (closeIndex !== tokens.length - 1) return undefined;

	const memberScan = scan_token_boundaries(tokens, openIndex + 1, closeIndex);
	if (!memberScan.valid) return undefined;
	const commaIndexes = memberScan.topLevelIndexes.filter(
		(tokenIndex) => tokens[tokenIndex].value === ",",
	);
	const lastCommaIndex = commaIndexes[commaIndexes.length - 1];
	const hasTrailingComma = lastCommaIndex === closeIndex - 1;
	const contentEnd = hasTrailingComma ? closeIndex - 1 : closeIndex;
	const memberEndIndexes = commaIndexes.filter((commaIndex) => commaIndex < contentEnd).concat(contentEnd);
	const memberRanges = memberEndIndexes.map((endIndex, memberIndex) => ({
		startIndex: memberIndex === 0 ? openIndex + 1 : memberEndIndexes[memberIndex - 1] + 1,
		endIndex,
	}));
	const members = memberRanges.map(({ startIndex, endIndex }) =>
		renderedTokens.slice(startIndex, endIndex).join("").trim(),
	);
	if (members.length === 0 || members.some((member) => member.length === 0)) return undefined;

	const indentationUnit = get_indentation_unit(document, leadingWhitespace, tabSize);
	const memberIndent = leadingWhitespace + indentationUnit;
	const maxLineLength = get_max_line_length(options);
	const firstLine = leadingWhitespace + renderedTokens.slice(0, openIndex + 1).join("");
	const closingLine = leadingWhitespace + tokens[closeIndex].value;
	const wrappedLines = [
		firstLine,
		...members.map((member) => `${memberIndent}${member},`),
		closingLine,
	];
	return wrappedLines.some((wrappedLine) => get_line_width(wrappedLine, tabSize) > maxLineLength)
		? undefined
		: wrappedLines.join("\n");
}

/** Render one array or dictionary, recursively wrapping elements that remain overlong. */
function wrap_collection_candidate(
	tokens: Token[],
	renderedTokens: string[],
	rangeStart: number,
	rangeEnd: number,
	leadingWhitespace: string,
	trailingSuffix: string,
	maxLineLength: number,
	indentationUnit: string,
	continuationIndentLevel: number,
	openIndex: number,
	closeIndex: number,
	tabSize: number,
): string[] | undefined {
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
	if (!scan.valid) return undefined;
	const commaIndexes = scan.topLevelIndexes.filter(
		(tokenIndex) => tokens[tokenIndex].value === ",",
	);
	if (commaIndexes.length === 0) return undefined;

	const lastCommaIndex = commaIndexes[commaIndexes.length - 1];
	const hasTrailingComma = lastCommaIndex === closeIndex - 1;
	const contentEnd = hasTrailingComma ? closeIndex - 1 : closeIndex;
	const memberEndIndexes = commaIndexes.filter((commaIndex) => commaIndex < contentEnd).concat(contentEnd);
	const memberRanges = memberEndIndexes.map((endIndex, memberIndex) => ({
		startIndex: memberIndex === 0 ? openIndex + 1 : memberEndIndexes[memberIndex - 1] + 1,
		endIndex,
	}));
	const memberTexts = memberRanges.map(({ startIndex, endIndex }) =>
		renderedTokens.slice(startIndex, endIndex).join("").trim(),
	);
	if (memberTexts.length < 2 || memberTexts.some((memberText) => memberText.length === 0)) {
		return undefined;
	}

	const prefix = renderedTokens.slice(rangeStart, openIndex + 1).join("");
	const suffix = renderedTokens.slice(closeIndex + 1, rangeEnd).join("") + trailingSuffix;
	const firstLine = leadingWhitespace + prefix;
	if (get_line_width(firstLine, tabSize) > maxLineLength) return undefined;

	const collectionIndent = leadingWhitespace + indentationUnit;
	const renderedMembers = memberRanges.reduce(
		(state, memberRange, memberIndex) => {
			if (!state.valid) return state;

			const memberText = memberTexts[memberIndex];
			const singleLine = `${collectionIndent}${memberText},`;
			if (get_line_width(singleLine, tabSize) <= maxLineLength) {
				state.lines.push(singleLine);
				return state;
			}

			const nestedLines = wrap_collection_range(
				tokens,
				renderedTokens,
				memberRange.startIndex,
				memberRange.endIndex,
				collectionIndent,
				",",
				maxLineLength,
				indentationUnit,
				continuationIndentLevel,
				tabSize,
			);
			const wrappedEntryLines =
				nestedLines ??
				(openingValue === "{"
					? wrap_long_dictionary_entry_ternary_value(
						tokens,
						renderedTokens,
						memberRange.startIndex,
						memberRange.endIndex,
						collectionIndent,
						",",
						maxLineLength,
						indentationUnit,
						continuationIndentLevel,
						tabSize,
					) ??
						wrap_long_dictionary_entry_value(
						tokens,
						renderedTokens,
						memberRange.startIndex,
						memberRange.endIndex,
						collectionIndent,
						",",
						maxLineLength,
						indentationUnit,
						continuationIndentLevel,
						tabSize,
					) ??
						wrap_long_dictionary_entry_binary_value(
							tokens,
							renderedTokens,
							memberRange.startIndex,
							memberRange.endIndex,
							collectionIndent,
							",",
							maxLineLength,
							indentationUnit,
							continuationIndentLevel,
							tabSize,
						) ??
						wrap_long_dictionary_entry_boolean_value(
							tokens,
							renderedTokens,
							memberRange.startIndex,
							memberRange.endIndex,
							collectionIndent,
							",",
							maxLineLength,
							indentationUnit,
							continuationIndentLevel,
							tabSize,
						) ??
						wrap_long_dictionary_entry_comparison_value(
							tokens,
							renderedTokens,
							memberRange.startIndex,
							memberRange.endIndex,
							collectionIndent,
							",",
							maxLineLength,
							indentationUnit,
							continuationIndentLevel,
							tabSize,
						)
					: openingValue === "["
						? wrap_long_binary_expression_range(
							tokens,
							renderedTokens,
							memberRange.startIndex,
							memberRange.endIndex,
							collectionIndent,
							",",
							maxLineLength,
							indentationUnit,
							continuationIndentLevel,
							tabSize,
						)
						: undefined);
			if (!wrappedEntryLines || wrappedEntryLines.some((wrappedLine) => get_line_width(wrappedLine, tabSize) > maxLineLength)) {
				state.valid = false;
				return state;
			}
			state.lines.push(...wrappedEntryLines);
			return state;
		},
		{ valid: true, lines: [] as string[] },
	);
	if (!renderedMembers.valid) return undefined;

	const closingLine = leadingWhitespace + tokens[closeIndex].value + suffix;
	const wrappedLines = [firstLine, ...renderedMembers.lines, closingLine];
	return wrappedLines.some((wrappedLine) => get_line_width(wrappedLine, tabSize) > maxLineLength)
		? undefined
		: wrappedLines;
}

/** Find the first safe array or dictionary layout within a token range. */
function wrap_collection_range(
	tokens: Token[],
	renderedTokens: string[],
	rangeStart: number,
	rangeEnd: number,
	leadingWhitespace: string,
	trailingSuffix: string,
	maxLineLength: number,
	indentationUnit: string,
	continuationIndentLevel: number,
	tabSize: number,
): string[] | undefined {
	const delimiterScan = scan_token_boundaries(tokens, rangeStart, rangeEnd);
	if (!delimiterScan.valid) return undefined;

	return [...delimiterScan.matchingClosers.entries()]
		.filter(
			([openIndex, closeIndex]) =>
				openIndex >= rangeStart &&
				closeIndex < rangeEnd &&
				["[", "{"].includes(tokens[openIndex].value),
		)
		.sort((leftPair, rightPair) => leftPair[0] - rightPair[0])
		.reduce<string[] | undefined>(
			(wrappedLines, [openIndex, closeIndex]) =>
				wrappedLines ??
				wrap_collection_candidate(
					tokens,
					renderedTokens,
					rangeStart,
					rangeEnd,
					leadingWhitespace,
					trailingSuffix,
					maxLineLength,
					indentationUnit,
					continuationIndentLevel,
					openIndex,
					closeIndex,
					tabSize,
				),
			undefined,
		);
}

/**
 * Wrap long inline arrays and dictionaries at top-level commas, recursively handling
 * nested collections only when a containing member cannot fit on a single line.
 */
function wrap_long_collection_literal(
	tokens: Token[],
	renderedTokens: string[],
	leadingWhitespace: string,
	document: TextDocument,
	options: FormatterOptions,
	tabSize: number,
	currentLineWidth: number,
): string | undefined {
	const maxLineLength = get_max_line_length(options);
	if (currentLineWidth <= maxLineLength || tokens[0]?.string) return undefined;

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

	const indentationUnit = get_indentation_unit(document, leadingWhitespace, tabSize);
	const configuredIndentLevel = options.continuationIndentLevel;
	const continuationIndentLevel =
		typeof configuredIndentLevel === "number" && Number.isFinite(configuredIndentLevel)
			? Math.max(1, Math.min(4, Math.round(configuredIndentLevel)))
			: 1;
	return wrap_collection_range(
		tokens,
		renderedTokens,
		0,
		tokens.length,
		leadingWhitespace,
		"",
		maxLineLength,
		indentationUnit,
		continuationIndentLevel,
		tabSize,
	)?.join("\n");
}

/**
 * Locate an inline statement body separated from a GDScript block header by its structural colon.
 * This intentionally operates only on top-level token boundaries: colons inside strings,
 * parameter lists, typed loop variables, and collection literals are not suite separators.
 */
const blockHeaderKeywords = new Set([
	"if",
	"elif",
	"else",
	"for",
	"while",
	"match",
	"func",
	"class",
	"get",
	"set",
]);

/** Detect inline accessor bodies on annotated or static variable declarations. */
function has_potential_property_accessor(tokens: Token[]): boolean {
	const firstValue = tokens[0]?.value ?? "";
	if (
		firstValue !== "var" &&
		firstValue !== "static" &&
		firstValue !== "@" &&
		!firstValue.startsWith("@")
	) {
		return false;
	}
	if (
		!tokens.some(
			(token, tokenIndex) =>
				token.value === ":" && ["get", "set"].includes(tokens[tokenIndex + 1]?.value ?? ""),
		)
	) {
		return false;
	}

	const boundaryScan = scan_token_boundaries(tokens);
	if (!boundaryScan.valid) return false;
	const variableIndex = boundaryScan.topLevelIndexes.find(
		(tokenIndex) => tokens[tokenIndex].value === "var",
	);
	if (
		variableIndex === undefined ||
		!has_supported_variable_declaration_prefix(tokens, variableIndex, boundaryScan.matchingClosers)
	) {
		return false;
	}

	const topLevelColons = boundaryScan.topLevelIndexes.filter(
		(tokenIndex) => tokens[tokenIndex].value === ":",
	);
	return topLevelColons.some(
		(colonIndex) =>
			["get", "set"].includes(tokens[colonIndex + 1]?.value ?? "") &&
			topLevelColons.some((candidate) => candidate > colonIndex + 1),
	);
}

/** Accept only a static modifier and/or annotation prefixes before the top-level var keyword. */
function has_supported_variable_declaration_prefix(
	tokens: Token[],
	variableIndex: number,
	matchingClosers: Map<number, number>,
	prefixIndex = tokens[0]?.value === "static" ? 1 : 0,
): boolean {
	if (prefixIndex === variableIndex) return true;
	if (prefixIndex > variableIndex) return false;

	const prefixValue = tokens[prefixIndex]?.value ?? "";
	if (prefixValue !== "@" && !prefixValue.startsWith("@")) return false;
	const annotationNameIndex = prefixValue === "@" ? prefixIndex + 1 : prefixIndex;
	if (
		prefixValue === "@" &&
		!/^[A-Za-z_]\w*$/.test(tokens[annotationNameIndex]?.value ?? "")
	) {
		return false;
	}

	const annotationEndIndex = prefixValue === "@" ? prefixIndex + 2 : prefixIndex + 1;
	if (tokens[annotationEndIndex]?.value !== "(") {
		return has_supported_variable_declaration_prefix(
			tokens,
			variableIndex,
			matchingClosers,
			annotationEndIndex,
		);
	}

	const closingIndex = matchingClosers.get(annotationEndIndex);
	if (closingIndex === undefined || closingIndex >= variableIndex) return false;
	return has_supported_variable_declaration_prefix(
		tokens,
		variableIndex,
		matchingClosers,
		closingIndex + 1,
	);
}

function find_inline_suite_boundary(
	tokens: Token[],
	isMatchCaseLine: boolean,
): { colonIndex: number; isMatchHeader: boolean } | undefined {
	if (tokens.length < 2 || tokens[0]?.string) return undefined;

	const firstValue = tokens[0]?.value ?? "";
	const headerKeywordIndex = firstValue === "static" && tokens[1]?.value === "func" ? 1 : 0;
	const headerKeyword = tokens[headerKeywordIndex]?.value ?? "";
	const isBlockHeader = blockHeaderKeywords.has(headerKeyword);
	const hasPotentialPropertyAccessor = has_potential_property_accessor(tokens);
	if (!isBlockHeader && !isMatchCaseLine && !hasPotentialPropertyAccessor) return undefined;

	const boundaryScan = scan_token_boundaries(tokens);
	if (!boundaryScan.valid) return undefined;

	const topLevelColons = boundaryScan.topLevelIndexes.filter(
		(tokenIndex) => tokens[tokenIndex].value === ":",
	);
	if (topLevelColons.length === 0) return undefined;

	if (hasPotentialPropertyAccessor) {
		const declarationColon = topLevelColons.find(
			(colonIndex) =>
				["get", "set"].includes(tokens[colonIndex + 1]?.value ?? "") &&
				topLevelColons.some((candidate) => candidate > colonIndex + 1),
		);
		if (declarationColon !== undefined) {
			return { colonIndex: declarationColon, isMatchHeader: false };
		}
	}
	if (!isBlockHeader && !isMatchCaseLine) return undefined;

	// The first top-level colon ends a block header. For loops are the exception:
	// a typed iteration variable may have its own top-level type colon before "in".
	const forInIndex =
		headerKeyword === "for"
			? boundaryScan.topLevelIndexes.find(
					(tokenIndex) => tokenIndex > headerKeywordIndex && tokens[tokenIndex].value === "in",
				)
			: undefined;
	const colonIndex =
		headerKeyword === "for"
			? forInIndex === undefined
				? -1
				: (topLevelColons.find((candidate) => candidate > forInIndex) ?? -1)
			: topLevelColons[0];
	if (colonIndex < 0) return undefined;

	return { colonIndex, isMatchHeader: isBlockHeader && headerKeyword === "match" };
}

/**
 * Describe inline block headers so following physical lines can retain their logical indentation.
 * A final open header needs extra indentation because earlier headers from the same source line
 * become distinct lines after formatting.
 */
function get_inline_block_chain(
	tokens: Token[],
	isMatchCaseLine = false,
	headerCount = 0,
	matchHeaderDepth?: number,
): { headerCount: number; endsWithOpenSuite: boolean; matchHeaderDepth?: number } {
	const firstValue = tokens[0]?.value ?? "";
	const headerKeywordIndex = firstValue === "static" && tokens[1]?.value === "func" ? 1 : 0;
	const headerKeyword = tokens[headerKeywordIndex]?.value ?? "";
	const hasPotentialPropertyAccessor = has_potential_property_accessor(tokens);
	const isPotentialBlockHeader = blockHeaderKeywords.has(headerKeyword) || hasPotentialPropertyAccessor;
	if (!isPotentialBlockHeader && !isMatchCaseLine) {
		return { headerCount, endsWithOpenSuite: false, matchHeaderDepth };
	}

	const boundary = find_inline_suite_boundary(tokens, isMatchCaseLine);
	if (!boundary) return { headerCount, endsWithOpenSuite: false, matchHeaderDepth };

	const nextMatchHeaderDepth =
		headerKeyword === "match" && matchHeaderDepth === undefined ? headerCount : matchHeaderDepth;
	const nextHeaderCount = headerCount + 1;
	const bodyTokens = tokens.slice(boundary.colonIndex + 1);
	const hasBodyStatement = bodyTokens.some((token) => token.type !== "comment");
	if (!hasBodyStatement) {
		return {
			headerCount: nextHeaderCount,
			endsWithOpenSuite: true,
			matchHeaderDepth: nextMatchHeaderDepth,
		};
	}

	if (!boundary.isMatchHeader && !blockHeaderKeywords.has(bodyTokens[0]?.value ?? "")) {
		return {
			headerCount: nextHeaderCount,
			endsWithOpenSuite: false,
			matchHeaderDepth: nextMatchHeaderDepth,
		};
	}

	return get_inline_block_chain(
		bodyTokens,
		boundary.isMatchHeader,
		nextHeaderCount,
		nextMatchHeaderDepth,
	);
}

/**
 * Format a logical line through the common layout pipeline. Inline block suites are
 * split into a header and an indented body first, then both pieces use the same rules.
 * Lambda expressions remain intact because they do not start with a block declaration.
 */
type FormatterIntegrityUnit = { kind: "payload" | "character"; value: string };

const FORMATTER_INTEGRITY_PATTERN =
	/("""[\s\S]*?(?:"""|$)|'''[\s\S]*?(?:'''|$)|"(?:\\.|[^"\\])*(?:"|$)|'(?:\\.|[^'\\])*(?:'|$)|#.*|[^\t\r\n ])/g;
const FORMATTER_GENERATED_DELIMITERS = new Set(["(", ")", ","]);

/**
 * Treat strings and comments as opaque payloads, while discarding only code whitespace.
 * This lets us compare lexical content across formatter-generated line breaks and indentation.
 */
function get_formatter_integrity_units(source: string): FormatterIntegrityUnit[] {
	return (source.match(FORMATTER_INTEGRITY_PATTERN) ?? []).map((value) => ({
		kind:
			value.startsWith("#") || value.startsWith("\"") || value.startsWith("'")
				? "payload"
				: "character",
		value,
	}));
}

/**
 * Formatting may add layout parentheses and enum/collection commas, but must not alter,
 * remove, or inject any other source characters. Return false to preserve the raw input line.
 */
function preserves_source_characters(source: string, formatted: string): boolean {
	const sourceUnits = get_formatter_integrity_units(source);
	const formattedUnits = get_formatter_integrity_units(formatted);
	const comparison = formattedUnits.reduce(
		(state, unit) => {
			if (!state.valid) return state;
			const expected = sourceUnits[state.sourceIndex];
			if (expected && expected.kind === unit.kind && expected.value === unit.value) {
				state.sourceIndex++;
				return state;
			}
			if (unit.kind === "character" && FORMATTER_GENERATED_DELIMITERS.has(unit.value)) return state;
			state.valid = false;
			return state;
		},
		{ sourceIndex: 0, valid: true },
	);
	return comparison.valid && comparison.sourceIndex === sourceUnits.length;
}

function format_token_line(
	tokens: Token[],
	renderedTokens: string[],
	leadingWhitespace: string,
	currentLine: string,
	document: TextDocument,
	options: FormatterOptions,
	tabSize: number,
	isMatchCaseLine = false,
): string {
	const suiteBoundary = find_inline_suite_boundary(tokens, isMatchCaseLine);
	if (
		suiteBoundary &&
		tokens.slice(suiteBoundary.colonIndex + 1).some((token) => token.type !== "comment")
	) {
		const { colonIndex, isMatchHeader } = suiteBoundary;
		const headerTokens = tokens.slice(0, colonIndex + 1);
		const headerRenderedTokens = renderedTokens.slice(0, colonIndex + 1);
		const bodyTokens = tokens.slice(colonIndex + 1);
		const bodyRenderedTokens = renderedTokens.slice(colonIndex + 1);
		if (bodyRenderedTokens.length > 0) {
			bodyRenderedTokens[0] = bodyRenderedTokens[0].trimStart();
		}

		const headerLine = leadingWhitespace + headerRenderedTokens.join("");
		const formattedHeader = format_token_line(
			headerTokens,
			headerRenderedTokens,
			leadingWhitespace,
			headerLine,
			document,
			options,
			tabSize,
		);
		const indentationUnit = get_indentation_unit(document, leadingWhitespace, tabSize);
		const bodyIndentation = leadingWhitespace + indentationUnit;
		const bodyLine = bodyIndentation + bodyRenderedTokens.join("");
		const formattedBody = format_token_line(
			bodyTokens,
			bodyRenderedTokens,
			bodyIndentation,
			bodyLine,
			document,
			options,
			tabSize,
			isMatchHeader,
		);
		return `${formattedHeader}\n${formattedBody}`;
	}

	const currentLineWidth = get_line_width(currentLine, tabSize);

	return (
		format_inline_enum_declaration(tokens, renderedTokens, leadingWhitespace, document, options, tabSize) ??
		wrap_long_function_declaration(tokens, renderedTokens, leadingWhitespace, document, options, tabSize, currentLineWidth) ??
		// Prefer preserving a compact assigned call before general expression wrappers
		// can split the call's own argument list.
		wrap_long_assignment_call_expression(tokens, renderedTokens, leadingWhitespace, document, options, tabSize, currentLineWidth) ??
		wrap_long_boolean_condition(tokens, renderedTokens, leadingWhitespace, document, options, tabSize, currentLineWidth) ??
		wrap_long_ternary_expression(tokens, renderedTokens, leadingWhitespace, document, options, tabSize, currentLineWidth) ??
		wrap_long_boolean_expression(tokens, renderedTokens, leadingWhitespace, document, options, tabSize, currentLineWidth) ??
		wrap_long_comparison_expression(tokens, renderedTokens, leadingWhitespace, document, options, tabSize, currentLineWidth) ??
		wrap_long_function_call(tokens, renderedTokens, leadingWhitespace, document, options, tabSize, currentLineWidth) ??
		wrap_long_collection_literal(tokens, renderedTokens, leadingWhitespace, document, options, tabSize, currentLineWidth) ??
		wrap_long_binary_operator_expression(tokens, renderedTokens, leadingWhitespace, document, options, tabSize, currentLineWidth) ??
		wrap_long_method_chain(tokens, renderedTokens, leadingWhitespace, document, options, tabSize, currentLineWidth) ??
		currentLine
	);
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
	document: TextDocument,
	options: FormatterOptions,
	tabSize: number,
	currentLineWidth: number,
): string | undefined {
	const maxLineLength = get_max_line_length(options);
	if (currentLineWidth <= maxLineLength || tokens[0]?.string) return undefined;

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
	const assignmentIndexes = boundaryScan.topLevelIndexes.filter((tokenIndex) =>
		assignmentOperators.has(tokens[tokenIndex].value),
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
			: 1;
	const indentationUnit = get_indentation_unit(document, leadingWhitespace, tabSize);
	const continuationIndent = leadingWhitespace + indentationUnit.repeat(continuationIndentLevel);
	const expressionPrefix =
		renderedTokens.slice(0, expressionStart).join("") + between(tokens, expressionStart, options);
	const firstLine = `${leadingWhitespace + expressionPrefix}(`;
	const wrappedLines = [
		firstLine,
		...segments.map((segment) => `${continuationIndent}${segment}`),
		`${leadingWhitespace})`,
	];

	return wrappedLines.some((wrappedLine) => get_line_width(wrappedLine, tabSize) > maxLineLength)
		? undefined
		: wrappedLines.join("\n");
}

/** Synchronous entry point retained for callers that have already loaded the grammar. */
export function format_document(document: TextDocument, _options?: FormatterOptions): TextEdit[] {
	const activeGrammar = grammar;
	if (!activeGrammar) return [];
	const edits: TextEdit[] = [];

	const options = _options ?? get_formatter_options();
	const tabSize = get_editor_tab_size(document);
	const debug = is_debug_mode();

	let lastToken = "";
	let lineTokens: vsctm.ITokenizeLineResult | undefined = undefined;
	let onlyEmptyLinesSoFar = true;
	let emptyLineCount = 0;
	let inLambdaBody = false;
	const multilineStringState: { delimiter: MultilineStringDelimiter | undefined } = { delimiter: undefined };
	const matchContexts: { indentation: string; caseIndentation?: string }[] = [];
	const inlineIndentContexts: InlineIndentContext[] = [];
	for (let lineNum = 0; lineNum < document.lineCount; lineNum++) {
		const line = document.lineAt(lineNum);

		// Advance lexical state before any skip path. Lines that look like comments,
		// blank lines, or conflict markers can still occur inside multiline strings.
		lineTokens = activeGrammar.tokenizeLine(line.text, lineTokens?.ruleStack ?? vsctm.INITIAL);

		const lineStartedInsideMultilineString = multilineStringState.delimiter !== undefined;
		multilineStringState.delimiter = advance_multiline_string_delimiter(line, lineTokens, multilineStringState.delimiter);
		if (lineStartedInsideMultilineString) {
			// Whitespace and indentation in multiline string continuations are literal data.
			continue;
		}

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
			const commentOffset = line.firstNonWhitespaceCharacterIndex;
			const commentToken = lineTokens.tokens.find(
				(token) => token.startIndex <= commentOffset && token.endIndex > commentOffset,
			);
			if (commentToken?.scopes.includes("comment.line.number-sign.gdscript")) {
				const sourceLeadingWhitespace = line.text.slice(0, commentOffset);
				const leadingWhitespace = apply_inline_indent_contexts(
					sourceLeadingWhitespace,
					inlineIndentContexts,
				);
				if (leadingWhitespace !== sourceLeadingWhitespace) {
					edits.push(
						TextEdit.replace(
							new vscode.Range(line.lineNumber, 0, line.lineNumber, sourceLeadingWhitespace.length),
							leadingWhitespace,
						),
					);
				}
			}
			continue;
		}

		// skip git merge conflict markers — formatting these corrupts them
		if (is_merge_conflict_marker(line)) {
			continue;
		}

		// TODO: detect whitespace type and automatically convert
		const sourceLeadingWhitespace = line.text.slice(0, line.firstNonWhitespaceCharacterIndex);
		const leadingWhitespace = apply_inline_indent_contexts(sourceLeadingWhitespace, inlineIndentContexts);
		const innermostMatchContextIndex = matchContexts.reduce(
			(index, matchContext, contextIndex) =>
				leadingWhitespace.length > matchContext.indentation.length &&
				leadingWhitespace.startsWith(matchContext.indentation)
					? contextIndex
					: index,
			-1,
		);
		matchContexts.splice(innermostMatchContextIndex + 1);
		const activeMatchContext = matchContexts[matchContexts.length - 1];
		let isMatchCaseLine = false;
		if (
			activeMatchContext &&
			leadingWhitespace.length > activeMatchContext.indentation.length &&
			leadingWhitespace.startsWith(activeMatchContext.indentation)
		) {
			if (!activeMatchContext.caseIndentation) {
				activeMatchContext.caseIndentation = leadingWhitespace;
			}
			isMatchCaseLine = activeMatchContext.caseIndentation === leadingWhitespace;
		}
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
		const formattedLine = format_token_line(
			tokens,
			renderedTokens,
			leadingWhitespace,
			nextLine,
			document,
			options,
			tabSize,
			isMatchCaseLine,
		);
		const safeFormattedLine =
			formattedLine === line.text || preserves_source_characters(line.text, formattedLine) ? formattedLine : line.text;

		const inlineBlockChain = get_inline_block_chain(tokens, isMatchCaseLine);
		if (inlineBlockChain.endsWithOpenSuite && inlineBlockChain.headerCount > 1) {
			inlineIndentContexts.push({
				baseIndentation: sourceLeadingWhitespace,
				extraLevels: inlineBlockChain.headerCount - 1,
				indentationUnit: get_indentation_unit(document, sourceLeadingWhitespace, tabSize),
			});
		}
		if (inlineBlockChain.endsWithOpenSuite && inlineBlockChain.matchHeaderDepth !== undefined) {
			matchContexts.push({
				indentation:
					leadingWhitespace +
					get_indentation_unit(document, leadingWhitespace, tabSize).repeat(inlineBlockChain.matchHeaderDepth),
			});
		}

		// Returning edits for unchanged lines costs allocations and slows VS Code's
		// edit application on large scripts. Keep only actual replacements.
		if (safeFormattedLine !== line.text) edits.push(TextEdit.replace(line.range, safeFormattedLine));
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
	document: TextDocument,
	options: FormatterOptions,
	tabSize: number,
	currentLineWidth: number,
): string | undefined {
	const maxLineLength = get_max_line_length(options);
	if (currentLineWidth <= maxLineLength || tokens[0]?.string) return undefined;

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
			: 1;
	const indentationUnit = get_indentation_unit(document, leadingWhitespace, tabSize);
	const continuationIndent = leadingWhitespace + indentationUnit.repeat(continuationIndentLevel);
	const expressionPrefix =
		renderedTokens.slice(0, expressionStart).join("") + between(tokens, expressionStart, options);
	const firstLine = `${leadingWhitespace + expressionPrefix}(`;
	const wrappedLines = [
		firstLine,
		...segments.map((segment) => `${continuationIndent}${segment}`),
		`${leadingWhitespace})`,
	];

	return wrappedLines.some((wrappedLine) => get_line_width(wrappedLine, tabSize) > maxLineLength)
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
	document: TextDocument,
	options: FormatterOptions,
	tabSize: number,
	currentLineWidth: number,
): string | undefined {
	const maxLineLength = get_max_line_length(options);
	if (currentLineWidth <= maxLineLength || tokens[0]?.string) return undefined;

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
			: 1;
	const indentationUnit = get_indentation_unit(document, leadingWhitespace, tabSize);
	const continuationIndent = leadingWhitespace + indentationUnit.repeat(continuationIndentLevel);
	const firstLine = leadingWhitespace + renderedTokens.slice(0, openIndex + 1).join("");
	const declarationSuffix = `)${renderedTokens.slice(closeIndex + 1).join("")}`;
	const wrappedLines = [
		firstLine,
		...parameterTexts.map((parameterText, parameterIndex) => {
			const isLastParameter = parameterIndex === parameterTexts.length - 1;
			return `${continuationIndent}${parameterText}${isLastParameter ? "" : ","}`;
		}),
		leadingWhitespace + declarationSuffix,
	];

	return wrappedLines.some((wrappedLine) => get_line_width(wrappedLine, tabSize) > maxLineLength)
		? undefined
		: wrappedLines.join("\n");
}


/**
 * Wrap long binary arithmetic, bitwise, and shift expressions in assignments and return statements.
 * Preserve unary operators and skip ambiguous operator combinations.
 */
function wrap_long_binary_operator_expression(
	tokens: Token[],
	renderedTokens: string[],
	leadingWhitespace: string,
	document: TextDocument,
	options: FormatterOptions,
	tabSize: number,
	currentLineWidth: number,
): string | undefined {
	const maxLineLength = get_max_line_length(options);
	if (currentLineWidth <= maxLineLength || tokens[0]?.string) return undefined;

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
	const binaryOperatorValues = new Set(["+", "-", "*", "/", "%", "**", "&", "|", "^", "<<", ">>"]);
	const binaryOperatorIndexes = topLevelIndexes.filter((tokenIndex) => {
		const currentToken = tokens[tokenIndex];
		if (!binaryOperatorValues.has(currentToken.value)) return false;

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
	const splitIndexes = binaryOperatorIndexes.filter((splitIndex) => splitIndex >= expressionStart);
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
			: 1;
	const indentationUnit = get_indentation_unit(document, leadingWhitespace, tabSize);
	const continuationIndent = leadingWhitespace + indentationUnit.repeat(continuationIndentLevel);
	const expressionPrefix =
		renderedTokens.slice(0, expressionStart).join("") + between(tokens, expressionStart, options);
	const firstLine = `${leadingWhitespace + expressionPrefix}(`;
	const wrappedLines = [
		firstLine,
		...segments.map((segment) => `${continuationIndent}${segment}`),
		`${leadingWhitespace})`,
	];

	return wrappedLines.some((wrappedLine) => get_line_width(wrappedLine, tabSize) > maxLineLength)
		? undefined
		: wrappedLines.join("\n");
}

/**
 * Wrap safe top-level symbolic comparisons in assignment, declaration, and return expressions.
 * Mixed boolean chains and ambiguous statements remain unchanged.
 */
function wrap_long_comparison_expression(
	tokens: Token[],
	renderedTokens: string[],
	leadingWhitespace: string,
	document: TextDocument,
	options: FormatterOptions,
	tabSize: number,
	currentLineWidth: number,
): string | undefined {
	const maxLineLength = get_max_line_length(options);
	if (currentLineWidth <= maxLineLength || tokens[0]?.string) return undefined;

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
					(token.value === "func" ||
						token.value === ";" ||
						(token.value.length === 1 && token.value.charCodeAt(0) === 92))),
		)
	) {
		return undefined;
	}

	const boundaryScan = scan_token_boundaries(tokens);
	if (!boundaryScan.valid) return undefined;
	const topLevelIndexes = boundaryScan.topLevelIndexes;
	const splitIndexes = topLevelIndexes.filter((tokenIndex) =>
		comparisonOperatorValues.has(tokens[tokenIndex].value),
	);
	if (splitIndexes.length === 0) return undefined;

	const assignmentIndexes = topLevelIndexes.filter((tokenIndex) =>
		["=", ":="].includes(tokens[tokenIndex].value),
	);
	if (firstValue === "return" && assignmentIndexes.length > 0) return undefined;
	if (firstValue !== "return" && assignmentIndexes.length !== 1) return undefined;
	const expressionStart = firstValue === "return" ? 1 : assignmentIndexes[0] + 1;
	if (expressionStart <= 0 || expressionStart >= splitIndexes[0]) return undefined;

	const expressionSplitIndexes = splitIndexes.filter((tokenIndex) => tokenIndex >= expressionStart);
	if (
		expressionSplitIndexes.length === 0 ||
		!has_valid_comparison_operands(tokens, expressionSplitIndexes, tokens.length)
	) {
		return undefined;
	}

	const unsupportedTopLevelValues = new Set([
		"&&",
		"||",
		"and",
		"as",
		"else",
		"if",
		"in",
		"is",
		"not",
		"or",
	]);
	if (
		topLevelIndexes.some(
			(tokenIndex) =>
				tokenIndex >= expressionStart &&
				unsupportedTopLevelValues.has(tokens[tokenIndex].value),
		)
	) {
		return undefined;
	}

	const segments = [...expressionSplitIndexes, tokens.length].map((endIndex, segmentIndex) => {
		const segmentStart = segmentIndex === 0 ? expressionStart : expressionSplitIndexes[segmentIndex - 1];
		return renderedTokens.slice(segmentStart, endIndex).join("").trim();
	});
	if (segments.some((segment) => segment.length === 0)) return undefined;

	const indentationUnit = get_indentation_unit(document, leadingWhitespace, tabSize);
	const configuredIndentLevel = options.continuationIndentLevel;
	const continuationIndentLevel =
		typeof configuredIndentLevel === "number" && Number.isFinite(configuredIndentLevel)
			? Math.max(1, Math.min(4, Math.round(configuredIndentLevel)))
			: 1;
	const continuationIndent = leadingWhitespace + indentationUnit.repeat(continuationIndentLevel);
	const expressionPrefix =
		renderedTokens.slice(0, expressionStart).join("") + between(tokens, expressionStart, options);
	const wrappedLines = [
		`${leadingWhitespace + expressionPrefix}(`,
		...segments.map((segment) => continuationIndent + segment),
		`${leadingWhitespace})`,
	];
	return wrappedLines.some((wrappedLine) => get_line_width(wrappedLine, tabSize) > maxLineLength)
		? undefined
		: wrappedLines.join("\n");
}

/**
 * Wrap an overlong property/method chain inside a parenthesized expression.
 * Safe argument and collection wrapping takes precedence; unsupported forms stay unchanged.
 */
function wrap_long_method_chain(
	tokens: Token[],
	renderedTokens: string[],
	leadingWhitespace: string,
	document: TextDocument,
	options: FormatterOptions,
	tabSize: number,
	currentLineWidth: number,
): string | undefined {
	const maxLineLength = get_max_line_length(options);
	if (currentLineWidth <= maxLineLength || tokens[0]?.string) return undefined;

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
			: 1;
	const indentationUnit = get_indentation_unit(document, leadingWhitespace, tabSize);
	const continuationIndent = leadingWhitespace + indentationUnit.repeat(continuationIndentLevel);
	const packedSegments = segments.reduce<string[]>((packed, segment) => {
		const previousSegmentIndex = packed.length - 1;
		const previousSegment = packed[previousSegmentIndex];
		if (
			previousSegment !== undefined &&
			get_line_width(`${continuationIndent}${previousSegment}${segment}`, tabSize) <= maxLineLength
		) {
			packed[previousSegmentIndex] = `${previousSegment}${segment}`;
			return packed;
		}
		packed.push(segment);
		return packed;
	}, []);

	const wrappedLines = [
		firstLine,
		...packedSegments.map((segment) => `${continuationIndent}${segment}`),
		`${leadingWhitespace})`,
	];

	return wrappedLines.some((wrappedLine) => get_line_width(wrappedLine, tabSize) > maxLineLength)
		? undefined
		: wrappedLines.join("\n");
}

