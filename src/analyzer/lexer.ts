export type GDScriptTokenKind = "identifier" | "number" | "string" | "operator" | "punctuation" | "newline" | "eof";

export interface GDScriptToken {
	kind: GDScriptTokenKind;
	value: string;
	start: number;
	end: number;
	line: number;
	character: number;
	indent: number;
}

function isIdentifierStart(code: number): boolean {
	return code === 95 || (code >= 65 && code <= 90) || (code >= 97 && code <= 122);
}

function isIdentifierPart(code: number): boolean {
	return isIdentifierStart(code) || (code >= 48 && code <= 57);
}

function isNumberContinuation(code: number): boolean {
	return isIdentifierPart(code) || code === 46;
}

const MULTI_CHAR_OPERATORS = new Set([
	"->",
	":=",
	"==",
	"!=",
	"<=",
	">=",
	"&&",
	"||",
	"**",
	"+=",
	"-=",
	"*=",
	"/=",
	"%=",
	"<<",
	">>",
	"...",
]);
const PUNCTUATION = "()[]{}:,.=+-*/%<>!&|?@";

export function lexGDScript(source: string): GDScriptToken[] {
	const tokens: GDScriptToken[] = [];
	let offset = 0;
	let line = 0;
	let character = 0;
	let lineIndent = 0;
	let atLineStart = true;

	const push = (kind: GDScriptTokenKind, start: number, value: string, tokenLine: number, tokenCharacter: number) => {
		tokens.push({
			kind,
			value,
			start,
			end: offset,
			line: tokenLine,
			character: tokenCharacter,
			indent: lineIndent,
		});
	};

	while (offset < source.length) {
		const char = source[offset];

		if (char === "\r" || char === "\n") {
			const start = offset;
			if (char === "\r" && source[offset + 1] === "\n") offset += 2;
			else offset += 1;
			push("newline", start, "\n", line, character);
			line += 1;
			character = 0;
			lineIndent = 0;
			atLineStart = true;
			continue;
		}

		if (atLineStart && (char === " " || char === "\t")) {
			lineIndent += 1;
			offset += 1;
			character += 1;
			continue;
		}

		if (char === " " || char === "\t") {
			offset += 1;
			character += 1;
			continue;
		}

		if (char === "#") {
			while (offset < source.length && source[offset] !== "\r" && source[offset] !== "\n") {
				offset += 1;
				character += 1;
			}
			continue;
		}

		atLineStart = false;
		const tokenLine = line;
		const tokenCharacter = character;
		const start = offset;

		const charCode = source.charCodeAt(offset);
		if (isIdentifierStart(charCode)) {
			offset += 1;
			character += 1;
			while (offset < source.length && isIdentifierPart(source.charCodeAt(offset))) {
				offset += 1;
				character += 1;
			}
			push("identifier", start, source.slice(start, offset), tokenLine, tokenCharacter);
			continue;
		}

		if (charCode >= 48 && charCode <= 57) {
			offset += 1;
			character += 1;
			while (offset < source.length && isNumberContinuation(source.charCodeAt(offset))) {
				offset += 1;
				character += 1;
			}
			push("number", start, source.slice(start, offset), tokenLine, tokenCharacter);
			continue;
		}

		if (char === '"' || char === "'") {
			const quote = char;
			offset += 1;
			character += 1;
			while (offset < source.length) {
				const current = source[offset];
				if (current === "\\") {
					offset += 2;
					character += 2;
					continue;
				}
				if (current === quote) {
					offset += 1;
					character += 1;
					break;
				}
				if (current === "\r" || current === "\n") break;
				offset += 1;
				character += 1;
			}
			push("string", start, source.slice(start, offset), tokenLine, tokenCharacter);
			continue;
		}

		const two = source.slice(offset, offset + 2);
		const three = source.slice(offset, offset + 3);
		const operator = MULTI_CHAR_OPERATORS.has(three) ? three : MULTI_CHAR_OPERATORS.has(two) ? two : undefined;

		if (operator) {
			offset += operator.length;
			character += operator.length;
			push("operator", start, operator, tokenLine, tokenCharacter);
			continue;
		}

		if (PUNCTUATION.includes(char)) {
			offset += 1;
			character += 1;
			push("punctuation", start, char, tokenLine, tokenCharacter);
			continue;
		}

		offset += 1;
		character += 1;
	}

	tokens.push({
		kind: "eof",
		value: "",
		start: source.length,
		end: source.length,
		line,
		character,
		indent: lineIndent,
	});

	return tokens;
}
