export type GDScriptTokenKind =
	| "identifier"
	| "number"
	| "string"
	| "operator"
	| "punctuation"
	| "newline"
	| "eof";

export interface GDScriptToken {
	kind: GDScriptTokenKind;
	value: string;
	start: number;
	end: number;
	line: number;
	character: number;
	indent: number;
}

const identifierStart = /[A-Za-z_]/;
const identifierPart = /[A-Za-z0-9_]/;

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

		if (identifierStart.test(char)) {
			offset += 1;
			character += 1;
			while (offset < source.length && identifierPart.test(source[offset])) {
				offset += 1;
				character += 1;
			}
			push("identifier", start, source.slice(start, offset), tokenLine, tokenCharacter);
			continue;
		}

		if (/\d/.test(char)) {
			offset += 1;
			character += 1;
			while (offset < source.length && /[A-Za-z0-9._]/.test(source[offset])) {
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
		const operator = ["->", ":=", "==", "!=", "<=", ">=", "&&", "||", "**", "+=", "-=", "*=", "/=", "%=", "<<", ">>"].includes(two)
			? two
			: ["..."].includes(three)
				? three
				: undefined;

		if (operator) {
			offset += operator.length;
			character += operator.length;
			push("operator", start, operator, tokenLine, tokenCharacter);
			continue;
		}

		if ("()[]{}:,.=+-*/%<>!&|?@".includes(char)) {
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
