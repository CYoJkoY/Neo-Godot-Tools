import {
	GDScriptClass,
	GDScriptClassName,
	GDScriptConstant,
	GDScriptDeclaration,
	GDScriptDiagnostic,
	GDScriptEnum,
	GDScriptEnumMember,
	GDScriptExtends,
	GDScriptFunction,
	GDScriptParameter,
	GDScriptParseResult,
	GDScriptScript,
	GDScriptSignal,
	GDScriptVariable,
	SourcePosition,
	SourceRange,
} from "./ast.js";
import { GDScriptToken, lexGDScript } from "./lexer.js";

export function parseGDScript(source: string): GDScriptParseResult {
	return new Parser(source).parse();
}

class Parser {
	private readonly tokens: GDScriptToken[];
	/** Line boundaries let range construction stay O(log lines), not O(source size). */
	private readonly lineStarts: number[] = [0];
	private readonly lineEnds: number[] = [];
	private index = 0;
	private readonly diagnostics: GDScriptDiagnostic[] = [];

	constructor(private readonly source: string) {
		this.tokens = lexGDScript(source);
		for (let offset = 0; offset < source.length; offset++) {
			const code = source.charCodeAt(offset);
			if (code === 13) {
				if (source.charCodeAt(offset + 1) === 10) offset++;
				this.lineEnds.push(offset);
				this.lineStarts.push(offset + 1);
			} else if (code === 10) {
				this.lineEnds.push(offset);
				this.lineStarts.push(offset + 1);
			}
		}
		this.lineEnds.push(source.length);
	}

	parse(): GDScriptParseResult {
		const declarations: GDScriptDeclaration[] = [];
		while (!this.at("eof")) {
			this.skipNewlines();
			if (this.at("eof")) break;
			const declaration = this.parseDeclaration(0);
			if (declaration) {
				declarations.push(declaration);
				continue;
			}
			this.skipLine();
		}
		const ast: GDScriptScript = {
			kind: "script",
			range: this.range(0, this.source.length),
			declarations,
		};
		return { ast, diagnostics: this.diagnostics };
	}

	private parseDeclaration(indent: number): GDScriptDeclaration | undefined {
		const start = this.current();
		if (start.indent !== indent) return undefined;
		if (this.atValue("@")) {
			// Annotations decorate the declaration that follows them; skipping the
			// prefix keeps `@export var speed := 1.0` visible to the index.
			this.skipAnnotations();
			if (this.atLineEnd()) return undefined;
		}
		const token = this.current();
		if (token.indent !== indent) return undefined;
		if (this.isKeyword("class_name")) return this.parseClassName();
		if (this.isKeyword("extends")) return this.parseExtends();
		if (this.isKeyword("signal")) return this.parseSignal();
		if (this.isKeyword("enum")) return this.parseEnum();
		if (this.isKeyword("const")) return this.parseConstant();
		if (this.isKeyword("var")) return this.parseVariable();
		if (this.isKeyword("static") && this.peek(1)?.value === "func") return this.parseFunction(true);
		if (this.isKeyword("func")) return this.parseFunction(false);
		if (this.isKeyword("class")) return this.parseClass(indent);
		return undefined;
	}

	private parseClassName(): GDScriptClassName | undefined {
		const start = this.current();
		this.advance();
		const name = this.consumeIdentifier("Expected class name.");
		if (!name) return undefined;
		this.skipToLineEnd();
		return {
			kind: "class_name",
			name: name.value,
			nameOffset: name.start,
			range: this.range(start.start, this.lineEndOffset(start.line)),
		};
	}

	private parseExtends(): GDScriptExtends | undefined {
		const start = this.current();
		this.advance();
		const parts: string[] = [];
		while (!this.atLineEnd() && !this.at("eof")) parts.push(this.advance().value);
		// `extends` never includes the declaration colon, but inner classes are
		// written as `class Worker extends Base:`, and a stray colon made every
		// base-class lookup fail.
		const name = parts.join("").replace(/:$/, "");
		if (!name) {
			this.error("Expected base class or script path.", start);
			return undefined;
		}
		return { kind: "extends", name, range: this.range(start.start, this.lineEndOffset(start.line)) };
	}

	private parseSignal(): GDScriptSignal | undefined {
		const start = this.current();
		this.advance();
		const name = this.consumeIdentifier("Expected signal name.");
		if (!name) return undefined;
		const parameters = this.parseParameterList();
		this.skipToLineEnd();
		return {
			kind: "signal",
			name: name.value,
			nameOffset: name.start,
			parameters,
			range: this.range(start.start, this.lineEndOffset(start.line)),
		};
	}

	private parseEnum(): GDScriptEnum | undefined {
		const start = this.current();
		this.advance();
		const nameToken = this.at("identifier") && !this.atValue("{") ? this.advance() : undefined;
		const members: GDScriptEnumMember[] = [];
		if (this.atValue("{")) {
			this.advance();
			while (!this.at("eof") && !this.atValue("}")) {
				if (!this.at("identifier")) {
					this.advance();
					continue;
				}
				const member = this.advance();
				let value: string | undefined;
				if (this.atValue("=")) {
					this.advance();
					value = this.readEnumValue();
				}
				members.push({ name: member.value, value, range: this.range(member.start, member.end) });
				if (this.atValue(",")) this.advance();
			}
			if (this.atValue("}")) this.advance();
		} else this.skipToLineEnd();
		return {
			kind: "enum",
			name: nameToken?.value,
			nameOffset: nameToken?.start,
			members,
			range: this.range(start.start, this.previous().end),
		};
	}

	private parseConstant(): GDScriptConstant | undefined {
		const start = this.current();
		this.advance();
		const name = this.consumeIdentifier("Expected constant name.");
		if (!name) return undefined;
		let type: string | undefined;
		if (this.atValue(":")) {
			this.advance();
			type = this.parseType();
		}
		let value: string | undefined;
		if (this.atValue("=")) {
			this.advance();
			value = this.readLineExpression();
		} else this.skipToLineEnd();
		return {
			kind: "constant",
			name: name.value,
			nameOffset: name.start,
			type,
			value,
			range: this.range(start.start, this.lineEndOffset(start.line)),
		};
	}

	private parseVariable(): GDScriptVariable | undefined {
		const start = this.current();
		this.advance();
		const name = this.consumeIdentifier("Expected variable name.");
		if (!name) return undefined;
		let type: string | undefined;
		if (this.atValue(":")) {
			this.advance();
			type = this.parseType();
		}
		let value: string | undefined;
		if (this.atValue("=")) {
			this.advance();
			value = this.readLineExpression();
		} else this.skipToLineEnd();
		return {
			kind: "variable",
			name: name.value,
			nameOffset: name.start,
			type,
			value,
			range: this.range(start.start, this.lineEndOffset(start.line)),
		};
	}

	private parseFunction(isStatic: boolean): GDScriptFunction | undefined {
		const start = this.current();
		if (isStatic) this.advance();
		this.expectKeyword("func", "Expected 'func'.");
		const name = this.consumeIdentifier("Expected function name.");
		if (!name) return undefined;
		const parameters = this.parseParameterList();
		let returnType: string | undefined;
		if (this.atValue("->")) {
			this.advance();
			returnType = this.parseType();
		}
		const headerEnd = this.lineEndOffset(start.line);
		this.skipToLineEnd();
		const bodyRange = this.findIndentedBody(start.indent, start.line);
		// Consume the body so statements inside it are never mistaken for class
		// members: `var speed := 1` inside a method used to become a script
		// variable that polluted completions and member resolution.
		if (bodyRange) this.skipToOffset(bodyRange.end.offset);
		return {
			kind: "function",
			name: name.value,
			nameOffset: name.start,
			parameters,
			returnType,
			static: isStatic,
			indent: start.indent,
			bodyRange,
			range: this.range(start.start, bodyRange?.end.offset ?? headerEnd),
		};
	}

	private parseClass(indent: number): GDScriptClass | undefined {
		const start = this.current();
		this.advance();
		const name = this.consumeIdentifier("Expected inner class name.");
		if (!name) return undefined;
		let extendsName: string | undefined;
		if (this.isKeyword("extends")) {
			this.advance();
			const parts: string[] = [];
			// `class Worker extends Base:` terminates the base name at the colon;
			// keeping it broke inner-class inheritance resolution. The rest of the
			// header line (the colon) still has to be consumed so the class body
			// below is parsed instead of skipped.
			while (!this.atLineEnd() && !this.at("eof") && !this.atValue(":")) parts.push(this.advance().value);
			extendsName = parts.join("");
			this.skipToLineEnd();
		} else this.skipToLineEnd();

		const declarations: GDScriptDeclaration[] = [];
		while (!this.at("eof")) {
			this.skipNewlines();
			const token = this.current();
			if (token.kind === "eof" || token.indent <= indent) break;
			const declaration = this.parseDeclaration(token.indent);
			if (declaration) declarations.push(declaration);
			else this.skipLine();
		}
		const end = declarations.length
			? declarations[declarations.length - 1].range.end.offset
			: this.lineEndOffset(start.line);
		return {
			kind: "class",
			name: name.value,
			nameOffset: name.start,
			extendsName,
			declarations,
			range: this.range(start.start, end),
		};
	}

	private parseParameterList(): GDScriptParameter[] {
		const parameters: GDScriptParameter[] = [];
		if (!this.atValue("(")) return parameters;
		this.advance();
		while (!this.at("eof") && !this.atValue(")")) {
			if (this.at("newline")) {
				this.advance();
				continue;
			}
			if (!this.at("identifier")) {
				this.advance();
				continue;
			}
			const start = this.current();
			const name = this.advance().value;
			let type: string | undefined;
			let defaultValue: string | undefined;
			if (this.atValue(":")) {
				this.advance();
				type = this.parseType();
			}
			if (this.atValue("=") || this.atValue(":=")) {
				this.advance();
				defaultValue = this.readParameterExpression();
			}
			parameters.push({ name, type, defaultValue, range: this.range(start.start, this.previous().end) });
			if (this.atValue(",")) this.advance();
		}
		if (this.atValue(")")) this.advance();
		else this.error("Expected ')'.", this.current());
		return parameters;
	}

	private parseType(): string {
		const parts: string[] = [];
		let depth = 0;
		while (!this.at("eof")) {
			const value = this.current().value;
			if (value === "[" || value === "<" || value === "(") depth++;
			if (value === "]" || value === ">" || value === ")") {
				if (depth === 0) break;
				depth--;
			}
			if (depth === 0 && [",", "=", "->", ":", "\n"].includes(value)) break;
			parts.push(this.advance().value);
		}
		return parts.join("");
	}

	private readLineExpression(): string {
		const parts: string[] = [];
		let depth = 0;
		while (!this.at("eof") && !this.at("newline")) {
			const value = this.current().value;
			if ("([{ ".includes(value)) depth++;
			if (")]}".includes(value)) depth--;
			parts.push(this.advance().value);
			if (depth < 0) break;
		}
		return parts.join(" ").trim();
	}

	private readParameterExpression(): string {
		const parts: string[] = [];
		let depth = 0;
		while (!this.at("eof")) {
			const value = this.current().value;
			if ("([{".includes(value)) depth++;
			if (")]}".includes(value)) {
				if (depth === 0) break;
				depth--;
			}
			if (depth === 0 && (value === "," || value === ")")) break;
			parts.push(this.advance().value);
		}
		return parts.join(" ").trim();
	}

	private findIndentedBody(parentIndent: number, headerLine: number): SourceRange | undefined {
		let cursor = this.index;
		while (cursor < this.tokens.length && this.tokens[cursor].line === headerLine) cursor++;
		while (cursor < this.tokens.length && this.tokens[cursor].kind === "newline") cursor++;
		if (
			cursor >= this.tokens.length ||
			this.tokens[cursor].kind === "eof" ||
			this.tokens[cursor].indent <= parentIndent
		)
			return undefined;
		const bodyStart = this.tokens[cursor].start;
		let bodyEnd = bodyStart;
		let previousLine = this.tokens[cursor].line;
		for (; cursor < this.tokens.length; cursor++) {
			const token = this.tokens[cursor];
			if (token.kind === "eof") break;
			if (token.line !== previousLine && token.indent <= parentIndent) break;
			bodyEnd = token.end;
			previousLine = token.line;
		}
		return this.range(bodyStart, bodyEnd);
	}

	/** Skips `@annotation` prefixes (including their arguments) on a declaration line. */
	private skipAnnotations(): void {
		while (this.atValue("@") && !this.at("eof")) {
			this.advance();
			if (this.at("identifier")) this.advance();
			if (this.atValue("(")) this.skipBalanced("(", ")");
		}
	}

	private skipBalanced(open: string, close: string): void {
		let depth = 0;
		while (!this.at("eof")) {
			const value = this.advance().value;
			if (value === open) depth++;
			else if (value === close && --depth <= 0) return;
		}
	}

	private readEnumValue(): string {
		const parts: string[] = [];
		let depth = 0;
		while (!this.at("eof")) {
			const value = this.current().value;
			if (depth === 0 && (value === "," || value === "}")) break;
			if ("([{".includes(value)) depth++;
			if (")]}".includes(value)) depth--;
			parts.push(this.advance().value);
		}
		return parts.join(" ").trim();
	}

	/** Advances past every token that starts before `offset`. */
	private skipToOffset(offset: number) {
		while (!this.at("eof") && this.current().start < offset) this.advance();
	}

	private skipToLineEnd() {
		while (!this.at("eof") && !this.at("newline")) this.advance();
	}

	private skipLine() {
		this.skipToLineEnd();
		if (this.at("newline")) this.advance();
	}

	private skipNewlines() {
		while (this.at("newline")) this.advance();
	}

	private expectKeyword(value: string, message: string) {
		if (this.isKeyword(value)) {
			this.advance();
			return true;
		}
		this.error(message, this.current());
		return false;
	}

	private consumeIdentifier(message: string): GDScriptToken | undefined {
		if (this.at("identifier")) return this.advance();
		this.error(message, this.current());
		return undefined;
	}

	private error(message: string, token: GDScriptToken) {
		this.diagnostics.push({ message, severity: "error", range: this.range(token.start, token.end) });
	}

	private isKeyword(value: string) {
		return this.at("identifier") && this.current().value === value;
	}

	private at(kind: GDScriptToken["kind"]) {
		return this.current().kind === kind;
	}

	private atLineEnd() {
		return this.at("newline") || this.at("eof");
	}

	private atValue(value: string) {
		return this.current().value === value;
	}

	private current() {
		return this.tokens[this.index];
	}

	private previous() {
		return this.tokens[Math.max(0, this.index - 1)];
	}

	private peek(distance: number) {
		return this.tokens[this.index + distance];
	}

	private advance() {
		const token = this.current();
		if (this.index < this.tokens.length - 1) this.index++;
		return token;
	}

	private lineEndOffset(line: number) {
		return this.lineEnds[Math.max(0, Math.min(line, this.lineEnds.length - 1))] ?? this.source.length;
	}

	private positionAt(offset: number): SourcePosition {
		const bounded = Math.max(0, Math.min(offset, this.source.length));
		// Find the final line start <= offset. Avoid slicing/scanning the source for
		// every AST range; files with many declarations otherwise become quadratic.
		let low = 0;
		let high = this.lineStarts.length;
		while (low < high) {
			const middle = (low + high) >>> 1;
			if (this.lineStarts[middle] <= bounded) low = middle + 1;
			else high = middle;
		}
		const line = Math.max(0, low - 1);
		return { offset: bounded, line, character: bounded - this.lineStarts[line] };
	}

	private range(start: number, end: number): SourceRange {
		return { start: this.positionAt(start), end: this.positionAt(Math.max(start, end)) };
	}
}
