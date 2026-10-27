//! GDScript tokenizer that mirrors `src/analyzer/lexer.ts` code unit for code unit.
//!
//! The reference TypeScript lexer is the contract. Every quirk below is
//! intentional: the differential test fails if the two implementations drift.

const std = @import("std");
const Allocator = std.mem.Allocator;

pub const Kind = enum {
    identifier,
    number,
    string,
    operator,
    punctuation,
    newline,
    eof,

    pub fn name(kind: Kind) []const u8 {
        return switch (kind) {
            .identifier => "identifier",
            .number => "number",
            .string => "string",
            .operator => "operator",
            .punctuation => "punctuation",
            .newline => "newline",
            .eof => "eof",
        };
    }
};

pub const Token = struct {
    kind: Kind,
    /// First code unit index, relative to the start of the source.
    start: usize,
    /// One past the last code unit. A string that ends with a backslash can
    /// report an end up to two code units past the source length.
    end: usize,
    line: usize,
    character: usize,
    indent: usize,
};

const two_character_operators = [_][]const u8{
    "->", ":=", "==", "!=", "<=", ">=", "&&", "||",
    "**", "+=", "-=", "*=", "/=", "%=", "<<", ">>",
};

const punctuation = "()[]{}:,.=+-*/%<>!&|?@";

fn isIdentifierStart(code: u16) bool {
    return code == '_' or (code >= 'A' and code <= 'Z') or (code >= 'a' and code <= 'z');
}

fn isIdentifierPart(code: u16) bool {
    return isIdentifierStart(code) or (code >= '0' and code <= '9');
}

fn isNumberContinuation(code: u16) bool {
    return isIdentifierPart(code) or code == '.';
}

fn matchesAscii(source_units: []const u16, ascii: []const u8) bool {
    if (source_units.len != ascii.len) return false;
    for (source_units, ascii) |unit, byte| {
        if (unit != byte) return false;
    }
    return true;
}

fn isPunctuation(code: u16) bool {
    for (punctuation) |byte| {
        if (code == byte) return true;
    }
    return false;
}

fn matchOperator(source: []const u16, offset: usize) ?[]const u8 {
    if (offset + 3 <= source.len and matchesAscii(source[offset..][0..3], "...")) return "...";
    if (offset + 2 > source.len) return null;
    const two = source[offset..][0..2];
    for (two_character_operators) |candidate| {
        if (matchesAscii(two, candidate)) return candidate;
    }
    return null;
}

/// Splits UTF-16 code units into tokens. Caller owns the returned slice.
pub fn lex(allocator: Allocator, source: []const u16) Allocator.Error![]Token {
    var tokens: std.ArrayList(Token) = .empty;
    errdefer tokens.deinit(allocator);

    var offset: usize = 0;
    var line: usize = 0;
    var character: usize = 0;
    var line_indent: usize = 0;
    var at_line_start = true;

    while (offset < source.len) {
        const unit = source[offset];

        if (unit == '\r' or unit == '\n') {
            const start = offset;
            if (unit == '\r' and offset + 1 < source.len and source[offset + 1] == '\n') {
                offset += 2;
            } else {
                offset += 1;
            }
            try tokens.append(allocator, .{
                .kind = .newline,
                .start = start,
                .end = offset,
                .line = line,
                .character = character,
                .indent = line_indent,
            });
            line += 1;
            character = 0;
            line_indent = 0;
            at_line_start = true;
            continue;
        }

        if ((unit == ' ' or unit == '\t') and at_line_start) {
            line_indent += 1;
            offset += 1;
            character += 1;
            continue;
        }

        if (unit == ' ' or unit == '\t') {
            offset += 1;
            character += 1;
            continue;
        }

        if (unit == '#') {
            while (offset < source.len and source[offset] != '\r' and source[offset] != '\n') {
                offset += 1;
                character += 1;
            }
            continue;
        }

        at_line_start = false;
        const token_line = line;
        const token_character = character;
        const start = offset;

        if (isIdentifierStart(unit)) {
            offset += 1;
            character += 1;
            while (offset < source.len and isIdentifierPart(source[offset])) {
                offset += 1;
                character += 1;
            }
            try tokens.append(allocator, .{
                .kind = .identifier,
                .start = start,
                .end = offset,
                .line = token_line,
                .character = token_character,
                .indent = line_indent,
            });
            continue;
        }

        if (unit >= '0' and unit <= '9') {
            offset += 1;
            character += 1;
            while (offset < source.len and isNumberContinuation(source[offset])) {
                offset += 1;
                character += 1;
            }
            try tokens.append(allocator, .{
                .kind = .number,
                .start = start,
                .end = offset,
                .line = token_line,
                .character = token_character,
                .indent = line_indent,
            });
            continue;
        }

        if (unit == '"' or unit == '\'') {
            const quote = unit;
            offset += 1;
            character += 1;
            while (offset < source.len) {
                const current = source[offset];
                if (current == '\\') {
                    // The reference skips two code units even when the second
                    // one is past the end of the source.
                    offset += 2;
                    character += 2;
                    continue;
                }
                if (current == quote) {
                    offset += 1;
                    character += 1;
                    break;
                }
                if (current == '\r' or current == '\n') break;
                offset += 1;
                character += 1;
            }
            try tokens.append(allocator, .{
                .kind = .string,
                .start = start,
                .end = offset,
                .line = token_line,
                .character = token_character,
                .indent = line_indent,
            });
            continue;
        }

        if (matchOperator(source, offset)) |operator| {
            offset += operator.len;
            character += operator.len;
            try tokens.append(allocator, .{
                .kind = .operator,
                .start = start,
                .end = offset,
                .line = token_line,
                .character = token_character,
                .indent = line_indent,
            });
            continue;
        }

        if (isPunctuation(unit)) {
            offset += 1;
            character += 1;
            try tokens.append(allocator, .{
                .kind = .punctuation,
                .start = start,
                .end = offset,
                .line = token_line,
                .character = token_character,
                .indent = line_indent,
            });
            continue;
        }

        offset += 1;
        character += 1;
    }

    try tokens.append(allocator, .{
        .kind = .eof,
        .start = source.len,
        .end = source.len,
        .line = line,
        .character = character,
        .indent = line_indent,
    });

    return tokens.toOwnedSlice(allocator);
}

const newline_utf16le = [_]u8{ '\n', 0x00 };

/// Returns the token value encoded as UTF-16LE bytes, clamped to the source.
/// The returned slice is either a view into `source_utf16le` or a static
/// newline constant.
pub fn valueBytes(token: Token, source_utf16le: []const u8) []const u8 {
    switch (token.kind) {
        .newline => return &newline_utf16le,
        .eof => return "",
        else => {},
    }
    const unit_count = source_utf16le.len / 2;
    const start = @min(token.start, unit_count);
    const end = @min(token.end, unit_count);
    if (end <= start) return "";
    return source_utf16le[start * 2 .. end * 2];
}

fn expectTokens(source: []const u16, expected: []const Token) !void {
    const actual = try lex(std.testing.allocator, source);
    defer std.testing.allocator.free(actual);
    try std.testing.expectEqual(expected.len, actual.len);
    for (expected, actual) |want, got| {
        try std.testing.expectEqual(want.kind, got.kind);
        try std.testing.expectEqual(want.start, got.start);
        try std.testing.expectEqual(want.end, got.end);
        try std.testing.expectEqual(want.line, got.line);
        try std.testing.expectEqual(want.character, got.character);
        try std.testing.expectEqual(want.indent, got.indent);
    }
}

fn units(comptime text: []const u8) [text.len]u16 {
    var result: [text.len]u16 = undefined;
    for (text, 0..) |byte, index| result[index] = byte;
    return result;
}

test "empty source yields eof only" {
    const source = units("");
    const expected = [_]Token{.{ .kind = .eof, .start = 0, .end = 0, .line = 0, .character = 0, .indent = 0 }};
    try expectTokens(&source, &expected);
}

test "declaration, indentation and crlf" {
    const source = units("\tvar x := 1\r\n  # note\n   y = 2");
    const expected = [_]Token{
        .{ .kind = .identifier, .start = 1, .end = 4, .line = 0, .character = 1, .indent = 1 },
        .{ .kind = .identifier, .start = 5, .end = 6, .line = 0, .character = 5, .indent = 1 },
        .{ .kind = .operator, .start = 7, .end = 9, .line = 0, .character = 7, .indent = 1 },
        .{ .kind = .number, .start = 10, .end = 11, .line = 0, .character = 10, .indent = 1 },
        .{ .kind = .newline, .start = 11, .end = 13, .line = 0, .character = 11, .indent = 1 },
        .{ .kind = .newline, .start = 20, .end = 21, .line = 1, .character = 7, .indent = 2 },
        .{ .kind = .identifier, .start = 24, .end = 25, .line = 2, .character = 3, .indent = 3 },
        .{ .kind = .punctuation, .start = 26, .end = 27, .line = 2, .character = 5, .indent = 3 },
        .{ .kind = .number, .start = 28, .end = 29, .line = 2, .character = 7, .indent = 3 },
        .{ .kind = .eof, .start = 29, .end = 29, .line = 2, .character = 8, .indent = 3 },
    };
    try expectTokens(&source, &expected);
}

test "string escapes and unterminated strings" {
    const source = units("\"a\\\"b\" 'c\nd' \"tail\\");
    const expected = [_]Token{
        .{ .kind = .string, .start = 0, .end = 7, .line = 0, .character = 0, .indent = 0 },
        .{ .kind = .string, .start = 8, .end = 11, .line = 0, .character = 8, .indent = 0 },
        .{ .kind = .newline, .start = 11, .end = 12, .line = 0, .character = 11, .indent = 0 },
        .{ .kind = .identifier, .start = 12, .end = 13, .line = 1, .character = 0, .indent = 0 },
        .{ .kind = .string, .start = 14, .end = 22, .line = 1, .character = 2, .indent = 0 },
        .{ .kind = .eof, .start = 22, .end = 22, .line = 1, .character = 10, .indent = 0 },
    };
    try expectTokens(&source, &expected);
}

test "numbers and three character operators" {
    const source = units("1.2.3 4e+5 0x10 a...b -> ...");
    const expected = [_]Token{
        .{ .kind = .number, .start = 0, .end = 5, .line = 0, .character = 0, .indent = 0 },
        .{ .kind = .number, .start = 6, .end = 10, .line = 0, .character = 6, .indent = 0 },
        .{ .kind = .number, .start = 11, .end = 15, .line = 0, .character = 11, .indent = 0 },
        .{ .kind = .identifier, .start = 16, .end = 17, .line = 0, .character = 16, .indent = 0 },
        .{ .kind = .operator, .start = 17, .end = 20, .line = 0, .character = 17, .indent = 0 },
        .{ .kind = .identifier, .start = 20, .end = 21, .line = 0, .character = 20, .indent = 0 },
        .{ .kind = .operator, .start = 22, .end = 24, .line = 0, .character = 22, .indent = 0 },
        .{ .kind = .operator, .start = 25, .end = 28, .line = 0, .character = 25, .indent = 0 },
        .{ .kind = .eof, .start = 28, .end = 28, .line = 0, .character = 28, .indent = 0 },
    };
    try expectTokens(&source, &expected);
}

test "comment keeps line start state" {
    const source = units("  # c\n\t# d\n    x");
    const expected = [_]Token{
        .{ .kind = .newline, .start = 5, .end = 6, .line = 0, .character = 5, .indent = 2 },
        .{ .kind = .newline, .start = 10, .end = 11, .line = 1, .character = 4, .indent = 1 },
        .{ .kind = .identifier, .start = 15, .end = 16, .line = 2, .character = 4, .indent = 4 },
        .{ .kind = .eof, .start = 16, .end = 16, .line = 2, .character = 5, .indent = 4 },
    };
    try expectTokens(&source, &expected);
}

test "unknown code units are skipped" {
    const source = [_]u16{ 'a', 0x00e9, 'b' };
    const expected = [_]Token{
        .{ .kind = .identifier, .start = 0, .end = 1, .line = 0, .character = 0, .indent = 0 },
        .{ .kind = .identifier, .start = 2, .end = 3, .line = 0, .character = 2, .indent = 0 },
        .{ .kind = .eof, .start = 3, .end = 3, .line = 0, .character = 3, .indent = 0 },
    };
    try expectTokens(&source, &expected);
}
