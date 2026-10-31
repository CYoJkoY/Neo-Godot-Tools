//! Native GDScript declaration parser.
//!
//! `src/analyzer/parser.ts` is the contract. This parser intentionally follows
//! its cursor and line-boundary rules, including the quirks documented there:
//! declaration ranges end at the line terminator, function bodies own their
//! indented tokens, and a malformed declaration is skipped as a whole line.
//! The TypeScript parser remains the reference implementation and fallback.

const std = @import("std");
const Allocator = std.mem.Allocator;

const lexer = @import("lexer.zig");

pub const ParserError = Allocator.Error;

pub const Position = struct {
    offset: usize,
    line: usize,
    character: usize,
};

pub const Range = struct {
    start: Position,
    end: Position,
};

pub const Kind = enum {
    script,
    class,
    class_name,
    extends,
    signal,
    enum_decl,
    constant,
    variable,
    function,

    pub fn wireName(kind: Kind) []const u8 {
        return switch (kind) {
            .script => "script",
            .class => "class",
            .class_name => "class_name",
            .extends => "extends",
            .signal => "signal",
            .enum_decl => "enum",
            .constant => "constant",
            .variable => "variable",
            .function => "function",
        };
    }
};

pub const Parameter = struct {
    name: []const u16,
    type_name: ?[]const u16 = null,
    default_value: ?[]const u16 = null,
    range: Range,
};

pub const EnumMember = struct {
    name: []const u16,
    value: ?[]const u16 = null,
    range: Range,
};

pub const Declaration = struct {
    kind: Kind,
    range: Range,
    name: ?[]const u16 = null,
    name_offset: ?usize = null,
    type_name: ?[]const u16 = null,
    value: ?[]const u16 = null,
    extends_name: ?[]const u16 = null,
    parameters: []const Parameter = &.{},
    members: []const EnumMember = &.{},
    declarations: []const Declaration = &.{},
    return_type: ?[]const u16 = null,
    is_static: bool = false,
    indent: usize = 0,
    body_range: ?Range = null,
};

pub const Diagnostic = struct {
    message: []const u8,
    range: Range,
};

pub const Script = struct {
    range: Range,
    declarations: []const Declaration,
};

pub const ParseResult = struct {
    script: Script,
    diagnostics: []const Diagnostic,
};

const newline_units = [_]u16{'\n'};

/// Parses one UTF-16 source buffer. All returned slices live in `allocator`,
/// which the request handler supplies as an arena.
pub fn parse(allocator: Allocator, source: []const u16) ParserError!ParseResult {
    var parser = try Parser.init(allocator, source);
    defer parser.deinit();
    const script = try parser.parseScript();
    const diagnostics = try parser.diagnostics.toOwnedSlice(allocator);
    return .{ .script = script, .diagnostics = diagnostics };
}

const Parser = struct {
    allocator: Allocator,
    source: []const u16,
    tokens: []const lexer.Token,
    line_starts: std.ArrayList(usize) = .empty,
    line_ends: std.ArrayList(usize) = .empty,
    index: usize = 0,
    diagnostics: std.ArrayList(Diagnostic) = .empty,

    fn init(allocator: Allocator, source: []const u16) ParserError!Parser {
        const tokens = try lexer.lex(allocator, source);
        var parser = Parser{
            .allocator = allocator,
            .source = source,
            .tokens = tokens,
        };
        errdefer parser.deinitLists();
        try parser.line_starts.append(allocator, 0);
        var offset: usize = 0;
        while (offset < source.len) : (offset += 1) {
            const code = source[offset];
            if (code != 13 and code != 10) continue;
            if (code == 13 and offset + 1 < source.len and source[offset + 1] == 10) offset += 1;
            try parser.line_ends.append(allocator, offset);
            try parser.line_starts.append(allocator, offset + 1);
        }
        try parser.line_ends.append(allocator, source.len);
        return parser;
    }

    fn deinitLists(self: *Parser) void {
        self.line_starts.deinit(self.allocator);
        self.line_ends.deinit(self.allocator);
        self.diagnostics.deinit(self.allocator);
    }

    fn deinit(self: *Parser) void {
        self.deinitLists();
        self.allocator.free(self.tokens);
    }

    fn parseScript(self: *Parser) ParserError!Script {
        var declarations: std.ArrayList(Declaration) = .empty;
        errdefer declarations.deinit(self.allocator);
        while (!self.at(.eof)) {
            self.skipNewlines();
            if (self.at(.eof)) break;
            const declaration = try self.parseDeclaration(0);
            if (declaration) |node| {
                try declarations.append(self.allocator, node);
                continue;
            }
            self.skipLine();
        }
        return .{
            .range = self.range(0, self.source.len),
            .declarations = try declarations.toOwnedSlice(self.allocator),
        };
    }

    fn parseDeclaration(self: *Parser, indent: usize) ParserError!?Declaration {
        const start = self.current();
        if (start.indent != indent) return null;
        if (self.atValue("@")) {
            self.skipAnnotations();
            if (self.atLineEnd()) return null;
        }
        const token = self.current();
        if (token.indent != indent) return null;
        if (self.isKeyword("class_name")) return try self.parseClassName();
        if (self.isKeyword("extends")) return try self.parseExtends();
        if (self.isKeyword("signal")) return try self.parseSignal();
        if (self.isKeyword("enum")) return try self.parseEnum();
        if (self.isKeyword("const")) return try self.parseConstant();
        if (self.isKeyword("var")) return try self.parseVariable();
        if (self.isKeyword("static")) {
            if (self.peek(1)) |next| {
                if (self.tokenValueEquals(next, "func")) return try self.parseFunction(true);
            }
        }
        if (self.isKeyword("func")) return try self.parseFunction(false);
        if (self.isKeyword("class")) return try self.parseClass(indent);
        return null;
    }

    fn parseClassName(self: *Parser) ParserError!?Declaration {
        const start = self.current();
        _ = self.advance();
        const name = try self.consumeIdentifier("Expected class name.") orelse return null;
        self.skipToLineEnd();
        return .{
            .kind = .class_name,
            .name = self.tokenValue(name),
            .name_offset = name.start,
            .range = self.range(start.start, self.lineEndOffset(start.line)),
        };
    }

    fn parseExtends(self: *Parser) ParserError!?Declaration {
        const start = self.current();
        _ = self.advance();
        var parts: std.ArrayList([]const u16) = .empty;
        defer parts.deinit(self.allocator);
        while (!self.atLineEnd() and !self.at(.eof)) {
            const part = self.advance();
            try parts.append(self.allocator, self.tokenValue(part));
        }
        var name = try self.joinParts(parts.items, &[_]u16{});
        if (name.len > 0 and name[name.len - 1] == ':') name = name[0 .. name.len - 1];
        if (name.len == 0) {
            try self.recordDiagnostic("Expected base class or script path.", start);
            return null;
        }
        return .{
            .kind = .extends,
            .name = name,
            .range = self.range(start.start, self.lineEndOffset(start.line)),
        };
    }

    fn parseSignal(self: *Parser) ParserError!?Declaration {
        const start = self.current();
        _ = self.advance();
        const name = try self.consumeIdentifier("Expected signal name.") orelse return null;
        const parameters = try self.parseParameterList();
        self.skipToLineEnd();
        return .{
            .kind = .signal,
            .name = self.tokenValue(name),
            .name_offset = name.start,
            .parameters = parameters,
            .range = self.range(start.start, self.lineEndOffset(start.line)),
        };
    }

    fn readEnumMembers(self: *Parser) ParserError![]const EnumMember {
        if (!self.atValue("{")) {
            self.skipToLineEnd();
            return &.{};
        }
        _ = self.advance();
        var members: std.ArrayList(EnumMember) = .empty;
        errdefer members.deinit(self.allocator);
        while (!self.at(.eof) and !self.atValue("}")) {
            if (!self.at(.identifier)) {
                _ = self.advance();
                continue;
            }
            const member = self.advance();
            const value = try self.readEnumMemberValue();
            try members.append(self.allocator, .{
                .name = self.tokenValue(member),
                .value = value,
                .range = self.range(member.start, member.end),
            });
            if (self.atValue(",")) _ = self.advance();
        }
        if (self.atValue("}")) _ = self.advance();
        return members.toOwnedSlice(self.allocator);
    }

    fn parseEnum(self: *Parser) ParserError!?Declaration {
        const start = self.current();
        _ = self.advance();
        const name_token: ?lexer.Token = if (self.at(.identifier)) self.advance() else null;
        const members = try self.readEnumMembers();
        return .{
            .kind = .enum_decl,
            .name = if (name_token) |token| self.tokenValue(token) else null,
            .name_offset = if (name_token) |token| token.start else null,
            .members = members,
            .range = self.range(start.start, self.previous().end),
        };
    }

    fn parseConstant(self: *Parser) ParserError!?Declaration {
        const start = self.current();
        _ = self.advance();
        const name = try self.consumeIdentifier("Expected constant name.") orelse return null;
        const type_name = try self.readTypeAnnotation();
        const value = try self.readMemberValue();
        return .{
            .kind = .constant,
            .name = self.tokenValue(name),
            .name_offset = name.start,
            .type_name = type_name,
            .value = value,
            .range = self.range(start.start, self.lineEndOffset(start.line)),
        };
    }

    fn parseVariable(self: *Parser) ParserError!?Declaration {
        const start = self.current();
        _ = self.advance();
        const name = try self.consumeIdentifier("Expected variable name.") orelse return null;
        const type_name = try self.readTypeAnnotation();
        const value = try self.readMemberValue();
        return .{
            .kind = .variable,
            .name = self.tokenValue(name),
            .name_offset = name.start,
            .type_name = type_name,
            .value = value,
            .range = self.range(start.start, self.lineEndOffset(start.line)),
        };
    }

    fn parseFunction(self: *Parser, is_static: bool) ParserError!?Declaration {
        const start = self.current();
        if (is_static) _ = self.advance();
        try self.expectKeyword("func", "Expected 'func'.");
        const name = try self.consumeIdentifier("Expected function name.") orelse return null;
        const parameters = try self.parseParameterList();
        const return_type = try self.readReturnType();
        const header_end = self.lineEndOffset(start.line);
        self.skipToLineEnd();
        const body_range = try self.findIndentedBody(start.indent, start.line);
        if (body_range) |body| self.skipToOffset(body.end.offset);
        return .{
            .kind = .function,
            .name = self.tokenValue(name),
            .name_offset = name.start,
            .parameters = parameters,
            .return_type = return_type,
            .is_static = is_static,
            .indent = start.indent,
            .body_range = body_range,
            .range = self.range(start.start, if (body_range) |body| body.end.offset else header_end),
        };
    }

    fn readExtendsName(self: *Parser) ParserError!?[]const u16 {
        if (!self.isKeyword("extends")) return null;
        _ = self.advance();
        var parts: std.ArrayList([]const u16) = .empty;
        defer parts.deinit(self.allocator);
        while (!self.atLineEnd() and !self.at(.eof) and !self.atValue(":")) {
            const part = self.advance();
            try parts.append(self.allocator, self.tokenValue(part));
        }
        return try self.joinParts(parts.items, &[_]u16{});
    }

    fn parseClass(self: *Parser, indent: usize) ParserError!?Declaration {
        const start = self.current();
        _ = self.advance();
        const name = try self.consumeIdentifier("Expected inner class name.") orelse return null;
        const extends_name = try self.readExtendsName();
        self.skipToLineEnd();

        var declarations: std.ArrayList(Declaration) = .empty;
        errdefer declarations.deinit(self.allocator);
        while (!self.at(.eof)) {
            self.skipNewlines();
            const token = self.current();
            if (token.kind == .eof or token.indent <= indent) break;
            const declaration = try self.parseDeclaration(token.indent);
            if (declaration) |node| {
                try declarations.append(self.allocator, node);
                continue;
            }
            self.skipLine();
        }
        const end = if (declarations.items.len > 0)
            declarations.items[declarations.items.len - 1].range.end.offset
        else
            self.lineEndOffset(start.line);
        return .{
            .kind = .class,
            .name = self.tokenValue(name),
            .name_offset = name.start,
            .extends_name = extends_name,
            .declarations = try declarations.toOwnedSlice(self.allocator),
            .range = self.range(start.start, end),
        };
    }

    fn parseParameterList(self: *Parser) ParserError![]const Parameter {
        var parameters: std.ArrayList(Parameter) = .empty;
        errdefer parameters.deinit(self.allocator);
        if (!self.atValue("(")) return &.{};
        _ = self.advance();
        while (!self.at(.eof) and !self.atValue(")")) {
            if (self.at(.newline)) {
                _ = self.advance();
                continue;
            }
            if (!self.at(.identifier)) {
                _ = self.advance();
                continue;
            }
            const start = self.current();
            const name = self.advance();
            const type_name = try self.readTypeAnnotation();
            const default_value = try self.readParameterDefault();
            try parameters.append(self.allocator, .{
                .name = self.tokenValue(name),
                .type_name = type_name,
                .default_value = default_value,
                .range = self.range(start.start, self.previous().end),
            });
            if (self.atValue(",")) _ = self.advance();
        }
        if (!self.atValue(")")) try self.recordDiagnostic("Expected ')'.", self.current());
        if (self.atValue(")")) _ = self.advance();
        return parameters.toOwnedSlice(self.allocator);
    }

    fn readTypeAnnotation(self: *Parser) ParserError!?[]const u16 {
        if (!self.atValue(":")) return null;
        _ = self.advance();
        return try self.parseType();
    }

    fn readReturnType(self: *Parser) ParserError!?[]const u16 {
        if (!self.atValue("->")) return null;
        _ = self.advance();
        return try self.parseType();
    }

    fn readMemberValue(self: *Parser) ParserError!?[]const u16 {
        if (!self.atValue("=")) {
            self.skipToLineEnd();
            return null;
        }
        _ = self.advance();
        return try self.readLineExpression();
    }

    fn readParameterDefault(self: *Parser) ParserError!?[]const u16 {
        if (!self.atValue("=") and !self.atValue(":=")) return null;
        _ = self.advance();
        return try self.readParameterExpression();
    }

    fn readEnumMemberValue(self: *Parser) ParserError!?[]const u16 {
        if (!self.atValue("=")) return null;
        _ = self.advance();
        return try self.readEnumValue();
    }

    fn parseType(self: *Parser) ParserError![]const u16 {
        var parts: std.ArrayList([]const u16) = .empty;
        defer parts.deinit(self.allocator);
        var depth: usize = 0;
        while (!self.at(.eof)) {
            const value = self.currentValue();
            if (self.valueEquals(value, "[") or self.valueEquals(value, "<") or self.valueEquals(value, "(")) depth += 1;
            if (self.valueEquals(value, "]") or self.valueEquals(value, ">") or self.valueEquals(value, ")")) {
                if (depth == 0) break;
                depth -= 1;
            }
            if (depth == 0 and (self.valueEquals(value, ",") or
                self.valueEquals(value, "=") or
                self.valueEquals(value, "->") or
                self.valueEquals(value, ":") or
                self.valueEquals(value, "\n"))) break;
            const part = self.advance();
            try parts.append(self.allocator, self.tokenValue(part));
        }
        return try self.joinParts(parts.items, &[_]u16{});
    }

    fn readLineExpression(self: *Parser) ParserError![]const u16 {
        var parts: std.ArrayList([]const u16) = .empty;
        defer parts.deinit(self.allocator);
        var depth: isize = 0;
        const space = [_]u16{' '};
        while (!self.at(.eof) and !self.at(.newline)) {
            const value = self.currentValue();
            if (self.valueEquals(value, "(") or self.valueEquals(value, "[") or self.valueEquals(value, "{") or self.valueEquals(value, " ")) depth += 1;
            if (self.valueEquals(value, ")") or self.valueEquals(value, "]") or self.valueEquals(value, "}")) depth -= 1;
            const part = self.advance();
            try parts.append(self.allocator, self.tokenValue(part));
            if (depth < 0) break;
        }
        return self.trimUnits(try self.joinParts(parts.items, &space));
    }

    fn readParameterExpression(self: *Parser) ParserError![]const u16 {
        var parts: std.ArrayList([]const u16) = .empty;
        defer parts.deinit(self.allocator);
        var depth: usize = 0;
        const space = [_]u16{' '};
        while (!self.at(.eof)) {
            const value = self.currentValue();
            if (self.valueEquals(value, "(") or self.valueEquals(value, "[") or self.valueEquals(value, "{")) depth += 1;
            if (self.valueEquals(value, ")") or self.valueEquals(value, "]") or self.valueEquals(value, "}")) {
                if (depth == 0) break;
                depth -= 1;
            }
            if (depth == 0 and (self.valueEquals(value, ",") or self.valueEquals(value, ")"))) break;
            const part = self.advance();
            try parts.append(self.allocator, self.tokenValue(part));
        }
        return self.trimUnits(try self.joinParts(parts.items, &space));
    }

    fn readEnumValue(self: *Parser) ParserError![]const u16 {
        var parts: std.ArrayList([]const u16) = .empty;
        defer parts.deinit(self.allocator);
        var depth: isize = 0;
        const space = [_]u16{' '};
        while (!self.at(.eof)) {
            const value = self.currentValue();
            if (depth == 0 and (self.valueEquals(value, ",") or self.valueEquals(value, "}"))) break;
            if (self.valueEquals(value, "(") or self.valueEquals(value, "[") or self.valueEquals(value, "{")) depth += 1;
            if (self.valueEquals(value, ")") or self.valueEquals(value, "]") or self.valueEquals(value, "}")) depth -= 1;
            const part = self.advance();
            try parts.append(self.allocator, self.tokenValue(part));
        }
        return self.trimUnits(try self.joinParts(parts.items, &space));
    }

    fn findIndentedBody(self: *Parser, parent_indent: usize, header_line: usize) ParserError!?Range {
        var cursor = self.index;
        while (cursor < self.tokens.len and self.tokens[cursor].line == header_line) cursor += 1;
        while (cursor < self.tokens.len and self.tokens[cursor].kind == .newline) cursor += 1;
        if (cursor >= self.tokens.len or self.tokens[cursor].kind == .eof or self.tokens[cursor].indent <= parent_indent) return null;
        const body_start = self.tokens[cursor].start;
        var body_end = body_start;
        var previous_line = self.tokens[cursor].line;
        while (cursor < self.tokens.len) : (cursor += 1) {
            const token = self.tokens[cursor];
            if (token.kind == .eof) break;
            if (token.line != previous_line and token.indent <= parent_indent) break;
            body_end = token.end;
            previous_line = token.line;
        }
        return self.range(body_start, body_end);
    }

    fn skipAnnotations(self: *Parser) void {
        while (self.atValue("@") and !self.at(.eof)) {
            _ = self.advance();
            if (self.at(.identifier)) _ = self.advance();
            if (self.atValue("(")) self.skipBalanced("(", ")");
        }
    }

    fn skipBalanced(self: *Parser, open: []const u8, close: []const u8) void {
        var depth: isize = 0;
        while (!self.at(.eof)) {
            const value = self.tokenValue(self.advance());
            if (self.valueEquals(value, open)) {
                depth += 1;
                continue;
            }
            if (self.valueEquals(value, close)) {
                depth -= 1;
                if (depth <= 0) return;
            }
        }
    }

    fn skipToOffset(self: *Parser, offset: usize) void {
        while (!self.at(.eof) and self.current().start < offset) _ = self.advance();
    }

    fn skipToLineEnd(self: *Parser) void {
        while (!self.at(.eof) and !self.at(.newline)) _ = self.advance();
    }

    fn skipLine(self: *Parser) void {
        self.skipToLineEnd();
        if (self.at(.newline)) _ = self.advance();
    }

    fn skipNewlines(self: *Parser) void {
        while (self.at(.newline)) _ = self.advance();
    }

    fn expectKeyword(self: *Parser, value: []const u8, message: []const u8) ParserError!void {
        if (self.isKeyword(value)) {
            _ = self.advance();
            return;
        }
        try self.recordDiagnostic(message, self.current());
    }

    fn consumeIdentifier(self: *Parser, message: []const u8) ParserError!?lexer.Token {
        if (self.at(.identifier)) return self.advance();
        try self.recordDiagnostic(message, self.current());
        return null;
    }

    fn recordDiagnostic(self: *Parser, message: []const u8, token: lexer.Token) ParserError!void {
        try self.diagnostics.append(self.allocator, .{
            .message = message,
            .range = self.range(token.start, token.end),
        });
    }

    fn isKeyword(self: *Parser, value: []const u8) bool {
        if (!self.at(.identifier)) return false;
        return self.tokenValueEquals(self.current(), value);
    }

    fn at(self: *Parser, kind: lexer.Kind) bool {
        return self.current().kind == kind;
    }

    fn atLineEnd(self: *Parser) bool {
        return self.at(.newline) or self.at(.eof);
    }

    fn atValue(self: *Parser, value: []const u8) bool {
        return self.tokenValueEquals(self.current(), value);
    }

    fn current(self: *Parser) lexer.Token {
        return self.tokens[self.index];
    }

    fn previous(self: *Parser) lexer.Token {
        return self.tokens[if (self.index == 0) 0 else self.index - 1];
    }

    fn peek(self: *Parser, distance: usize) ?lexer.Token {
        const position = self.index + distance;
        if (position >= self.tokens.len) return null;
        return self.tokens[position];
    }

    fn advance(self: *Parser) lexer.Token {
        const token = self.current();
        if (self.index < self.tokens.len - 1) self.index += 1;
        return token;
    }

    fn lineEndOffset(self: *Parser, line: usize) usize {
        if (self.line_ends.items.len == 0) return self.source.len;
        const index = @min(line, self.line_ends.items.len - 1);
        return self.line_ends.items[index];
    }

    fn positionAt(self: *Parser, offset: usize) Position {
        const bounded = @min(offset, self.source.len);
        var low: usize = 0;
        var high = self.line_starts.items.len;
        while (low < high) {
            const middle = (low + high) / 2;
            if (self.line_starts.items[middle] <= bounded) low = middle + 1 else high = middle;
        }
        const line = if (low == 0) 0 else low - 1;
        return .{
            .offset = bounded,
            .line = line,
            .character = bounded - self.line_starts.items[line],
        };
    }

    fn range(self: *Parser, start: usize, end: usize) Range {
        return .{
            .start = self.positionAt(start),
            .end = self.positionAt(@max(start, end)),
        };
    }

    fn currentValue(self: *Parser) []const u16 {
        return self.tokenValue(self.current());
    }

    fn tokenValue(self: *Parser, token: lexer.Token) []const u16 {
        return switch (token.kind) {
            .newline => &newline_units,
            .eof => &[_]u16{},
            else => blk: {
                const end = @min(token.end, self.source.len);
                const start = @min(token.start, end);
                break :blk self.source[start..end];
            },
        };
    }

    fn tokenValueEquals(self: *Parser, token: lexer.Token, ascii: []const u8) bool {
        const value = self.tokenValue(token);
        if (value.len != ascii.len) return false;
        for (value, ascii) |unit, byte| {
            if (unit != byte) return false;
        }
        return true;
    }

    fn valueEquals(self: *Parser, value: []const u16, ascii: []const u8) bool {
        _ = self;
        if (value.len != ascii.len) return false;
        for (value, ascii) |unit, byte| {
            if (unit != byte) return false;
        }
        return true;
    }

    fn joinParts(self: *Parser, parts: []const []const u16, separator: []const u16) ParserError![]const u16 {
        var total: usize = 0;
        for (parts, 0..) |part, index| {
            total += part.len;
            if (index > 0) total += separator.len;
        }
        if (total == 0) return &.{};
        const result = try self.allocator.alloc(u16, total);
        var offset: usize = 0;
        for (parts, 0..) |part, index| {
            if (index > 0) {
                @memcpy(result[offset .. offset + separator.len], separator);
                offset += separator.len;
            }
            @memcpy(result[offset .. offset + part.len], part);
            offset += part.len;
        }
        return result;
    }

    fn trimUnits(self: *Parser, value: []const u16) []const u16 {
        _ = self;
        var start: usize = 0;
        var end = value.len;
        while (start < end and isWhitespace(value[start])) start += 1;
        while (end > start and isWhitespace(value[end - 1])) end -= 1;
        return value[start..end];
    }
};

fn isWhitespace(unit: u16) bool {
    return unit == ' ' or unit == '\t' or unit == '\r' or unit == '\n';
}

/// Encodes `source` and parses it inside `arena`. The result references arena
/// memory, so the caller must keep the arena alive for as long as the AST.
fn parseTestSource(arena: *std.heap.ArenaAllocator, source: []const u8) !ParseResult {
    const allocator = arena.allocator();
    const units = try std.unicode.utf8ToUtf16LeAlloc(allocator, source);
    return parse(allocator, units);
}

fn expectUnitText(expected: []const u8, actual: []const u16) !void {
    const units = try std.testing.allocator.alloc(u16, expected.len);
    defer std.testing.allocator.free(units);
    for (expected, 0..) |byte, index| units[index] = byte;
    try std.testing.expectEqualSlices(u16, units, actual);
}

test "parses top-level declarations" {
    const source =
        "class_name Player\n" ++
        "extends CharacterBody2D\n" ++
        "\n" ++
        "signal damaged(amount: int)\n" ++
        "const SPEED: float = 10.0\n" ++
        "var health: int = 100\n" ++
        "\n" ++
        "func move(direction: Vector2, speed := SPEED) -> void:\n" ++
        "\tposition += direction * speed\n";
    var arena = std.heap.ArenaAllocator.init(std.testing.allocator);
    defer arena.deinit();
    const result = try parseTestSource(&arena, source);
    try std.testing.expectEqual(@as(usize, 0), result.diagnostics.len);
    try std.testing.expectEqual(@as(usize, 6), result.script.declarations.len);
    try std.testing.expectEqual(Kind.class_name, result.script.declarations[0].kind);
    try expectUnitText("Player", result.script.declarations[0].name.?);
    try expectUnitText("CharacterBody2D", result.script.declarations[1].name.?);
    try expectUnitText("damaged", result.script.declarations[2].name.?);
    try expectUnitText("SPEED", result.script.declarations[3].name.?);
    try expectUnitText("float", result.script.declarations[3].type_name.?);
    try expectUnitText("10.0", result.script.declarations[3].value.?);
    try expectUnitText("health", result.script.declarations[4].name.?);
    const move = result.script.declarations[5];
    try std.testing.expectEqual(Kind.function, move.kind);
    try std.testing.expectEqual(@as(usize, 2), move.parameters.len);
    try expectUnitText("Vector2", move.parameters[0].type_name.?);
    try expectUnitText("SPEED", move.parameters[1].default_value.?);
    try expectUnitText("void", move.return_type.?);
    try std.testing.expect(move.body_range != null);
    try std.testing.expectEqual(@as(usize, 8), move.body_range.?.start.line);
    try std.testing.expectEqual(@as(usize, 1), move.body_range.?.start.character);
}

test "parses nested classes and enums" {
    const source =
        "class Inventory:\n" ++
        "\tenum Slot { WEAPON, ARMOR }\n" ++
        "\tvar capacity: int = 10\n" ++
        "\n" ++
        "func _ready():\n" ++
        "\tpass\n";
    var arena = std.heap.ArenaAllocator.init(std.testing.allocator);
    defer arena.deinit();
    const result = try parseTestSource(&arena, source);
    try std.testing.expectEqual(@as(usize, 0), result.diagnostics.len);
    try std.testing.expectEqual(@as(usize, 2), result.script.declarations.len);
    const inventory = result.script.declarations[0];
    try std.testing.expectEqual(Kind.class, inventory.kind);
    try std.testing.expectEqual(@as(usize, 2), inventory.declarations.len);
    const slot = inventory.declarations[0];
    try std.testing.expectEqual(Kind.enum_decl, slot.kind);
    try expectUnitText("Slot", slot.name.?);
    try std.testing.expectEqual(@as(usize, 2), slot.members.len);
    try expectUnitText("WEAPON", slot.members[0].name);
    try std.testing.expect(slot.members[0].value == null);
    try expectUnitText("ARMOR", slot.members[1].name);
    try expectUnitText("int", inventory.declarations[1].type_name.?);
}

test "joins enum member expressions" {
    const source = "enum Flags { A = 1 << 2, B = A | 4, C }\n";
    var arena = std.heap.ArenaAllocator.init(std.testing.allocator);
    defer arena.deinit();
    const result = try parseTestSource(&arena, source);
    try std.testing.expectEqual(@as(usize, 1), result.script.declarations.len);
    const flags = result.script.declarations[0];
    try std.testing.expectEqual(@as(usize, 3), flags.members.len);
    try expectUnitText("1 << 2", flags.members[0].value.?);
    try expectUnitText("A | 4", flags.members[1].value.?);
    try std.testing.expect(flags.members[2].value == null);
}

test "binds annotations to the following declaration" {
    const source =
        "@export_range(0, 10) var speed: int = 5\n" ++
        "@onready\n" ++
        "@warning_ignore(\"unused\")\n" ++
        "var label: Label = $Label\n";
    var arena = std.heap.ArenaAllocator.init(std.testing.allocator);
    defer arena.deinit();
    const result = try parseTestSource(&arena, source);
    try std.testing.expectEqual(@as(usize, 2), result.script.declarations.len);
    try expectUnitText("speed", result.script.declarations[0].name.?);
    try expectUnitText("5", result.script.declarations[0].value.?);
    try expectUnitText("label", result.script.declarations[1].name.?);
    // The lexer drops unrecognised characters such as `$`, and the TS parser
    // joins the remaining tokens; the native parser keeps that contract.
    try expectUnitText("Label", result.script.declarations[1].value.?);
}

test "keeps ranges stable across CRLF and mixed line endings" {
    const source = "var a = 1\r\nvar b = 2\nvar c = 3\rvar d = 4";
    var arena = std.heap.ArenaAllocator.init(std.testing.allocator);
    defer arena.deinit();
    const result = try parseTestSource(&arena, source);
    try std.testing.expectEqual(@as(usize, 4), result.script.declarations.len);
    try std.testing.expectEqual(@as(usize, 1), result.script.declarations[1].range.start.line);
    try std.testing.expectEqual(@as(usize, 2), result.script.declarations[2].range.start.line);
    try std.testing.expectEqual(@as(usize, 3), result.script.declarations[3].range.start.line);
    try std.testing.expectEqual(source.len, result.script.range.end.offset);
}

test "handles empty and whitespace-only sources" {
    var arena = std.heap.ArenaAllocator.init(std.testing.allocator);
    defer arena.deinit();
    const empty = try parseTestSource(&arena, "");
    try std.testing.expectEqual(@as(usize, 0), empty.script.declarations.len);
    try std.testing.expectEqual(@as(usize, 0), empty.script.range.end.offset);
    try std.testing.expectEqual(@as(usize, 0), empty.diagnostics.len);

    const blank = try parseTestSource(&arena, "   \n\t\n \t ");
    try std.testing.expectEqual(@as(usize, 0), blank.script.declarations.len);
    try std.testing.expectEqual(@as(usize, 0), blank.diagnostics.len);
}

test "accepts non-ASCII strings and lone surrogates" {
    const units = [_]u16{
        'v', 'a', 'r', ' ', 'l', 'a', 'b', 'e', 'l', ' ', '=', ' ', '"', 0x4f60, 0x597d, '"', '\n',
        'v', 'a', 'r', ' ', 'l', 'o', 'n', 'e', ' ', '=', ' ', '"', 0xd83d, '"', '\n',
    };
    var arena = std.heap.ArenaAllocator.init(std.testing.allocator);
    defer arena.deinit();
    const result = try parse(arena.allocator(), &units);
    try std.testing.expectEqual(@as(usize, 2), result.script.declarations.len);
    try std.testing.expectEqual(@as(usize, 4), result.script.declarations[0].value.?.len);
    try std.testing.expectEqual(@as(u16, 0x4f60), result.script.declarations[0].value.?[1]);
    try std.testing.expectEqual(@as(usize, 3), result.script.declarations[1].value.?.len);
    try std.testing.expectEqual(@as(u16, 0xd83d), result.script.declarations[1].value.?[1]);
}

test "parses static functions and optional fields" {
    const source = "static func make() -> Node:\n\treturn Node.new()\nvar plain\n";
    var arena = std.heap.ArenaAllocator.init(std.testing.allocator);
    defer arena.deinit();
    const result = try parseTestSource(&arena, source);
    try std.testing.expectEqual(@as(usize, 2), result.script.declarations.len);
    const make = result.script.declarations[0];
    try std.testing.expectEqual(Kind.function, make.kind);
    try std.testing.expect(make.is_static);
    try expectUnitText("Node", make.return_type.?);
    const plain = result.script.declarations[1];
    try std.testing.expect(plain.type_name == null);
    try std.testing.expect(plain.value == null);
}

test "reports malformed declarations with token ranges" {
    const source = "func ():\n\tpass\nvar = 1\n";
    var arena = std.heap.ArenaAllocator.init(std.testing.allocator);
    defer arena.deinit();
    const result = try parseTestSource(&arena, source);
    try std.testing.expectEqual(@as(usize, 2), result.diagnostics.len);
    try std.testing.expectEqualStrings("Expected function name.", result.diagnostics[0].message);
    try std.testing.expectEqual(@as(usize, 5), result.diagnostics[0].range.start.offset);
    try std.testing.expectEqual(@as(usize, 0), result.diagnostics[0].range.start.line);
    try std.testing.expectEqualStrings("Expected variable name.", result.diagnostics[1].message);
    try std.testing.expectEqual(@as(usize, 19), result.diagnostics[1].range.start.offset);
}

test "skips statements inside function bodies" {
    const source =
        "func _ready():\n" ++
        "\tvar local := 1\n" ++
        "\tif local > 0:\n" ++
        "\t\tprint(local)\n" ++
        "var member: int\n";
    var arena = std.heap.ArenaAllocator.init(std.testing.allocator);
    defer arena.deinit();
    const result = try parseTestSource(&arena, source);
    try std.testing.expectEqual(@as(usize, 2), result.script.declarations.len);
    try std.testing.expectEqual(Kind.function, result.script.declarations[0].kind);
    try expectUnitText("member", result.script.declarations[1].name.?);
}

test "parses inner class inheritance" {
    const source = "class Worker extends Base:\n\tvar speed = 1.0\nfunc after():\n\tpass\n";
    var arena = std.heap.ArenaAllocator.init(std.testing.allocator);
    defer arena.deinit();
    const result = try parseTestSource(&arena, source);
    try std.testing.expectEqual(@as(usize, 2), result.script.declarations.len);
    const worker = result.script.declarations[0];
    try std.testing.expectEqual(Kind.class, worker.kind);
    try expectUnitText("Base", worker.extends_name.?);
    try expectUnitText("1.0", worker.declarations[0].value.?);
    try std.testing.expectEqual(Kind.function, result.script.declarations[1].kind);
}
