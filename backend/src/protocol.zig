//! Content-Length framing and JSON-RPC 2.0 dispatch for the analysis sidecar.
//!
//! Frame boundaries are the only synchronisation point. Once a request body
//! has been read the connection can continue after a malformed body, because
//! the next frame starts at a known byte. Framing errors are different: the
//! rest of the stream cannot be located, so the server reports one error and
//! exits.

const std = @import("std");
const Allocator = std.mem.Allocator;

const lexer = @import("lexer.zig");

pub const backend_version = "0.1.0";
pub const zig_version = "0.17.0";
pub const protocol_version: i64 = 1;

pub const max_body_bytes: usize = 16 * 1024 * 1024;
pub const max_header_bytes: usize = 8 * 1024;

pub const FrameError = error{
    TruncatedHeader,
    HeaderTooLong,
    MalformedHeader,
    MissingContentLength,
    InvalidContentLength,
    ConflictingContentLength,
    BodyTooLarge,
    TruncatedBody,
    ReadFailed,
    OutOfMemory,
};

const HeaderReadError = error{ TruncatedHeader, HeaderTooLong, ReadFailed };

/// Errors from building a response in memory. The allocating JSON writer
/// reports allocation failure as `WriteFailed`, so callers map that name onto
/// `OutOfMemory` at the public boundary instead of exposing a writer detail.
pub const BuilderError = std.json.Stringify.Error || Allocator.Error;

fn mapBuilderError(err: BuilderError) Allocator.Error {
    return switch (err) {
        error.OutOfMemory => error.OutOfMemory,
        error.WriteFailed => error.OutOfMemory,
    };
}

/// Reads one header line without its LF terminator. A trailing CR is removed.
/// Returns null when the stream ends cleanly before the first byte.
fn readHeaderLine(reader: *std.Io.Reader, buffer: []u8) HeaderReadError!?[]const u8 {
    var length: usize = 0;
    while (true) {
        const byte = reader.takeByte() catch |err| switch (err) {
            error.EndOfStream => {
                if (length == 0) return null;
                return error.TruncatedHeader;
            },
            error.ReadFailed => return error.ReadFailed,
        };
        if (byte == '\n') break;
        if (length == buffer.len) return error.HeaderTooLong;
        buffer[length] = byte;
        length += 1;
    }
    if (length > 0 and buffer[length - 1] == '\r') length -= 1;
    return buffer[0..length];
}

fn trimAsciiOws(value: []const u8) []const u8 {
    var start: usize = 0;
    var end: usize = value.len;
    while (start < end and (value[start] == ' ' or value[start] == '\t')) start += 1;
    while (end > start and (value[end - 1] == ' ' or value[end - 1] == '\t')) end -= 1;
    return value[start..end];
}

fn parseContentLength(value: []const u8) FrameError!usize {
    const trimmed = trimAsciiOws(value);
    if (trimmed.len == 0) return error.InvalidContentLength;
    var result: usize = 0;
    for (trimmed) |byte| {
        if (byte < '0' or byte > '9') return error.InvalidContentLength;
        result = std.math.mul(usize, result, 10) catch return error.InvalidContentLength;
        result = std.math.add(usize, result, byte - '0') catch return error.InvalidContentLength;
    }
    return result;
}

fn eqlIgnoreCase(left: []const u8, right: []const u8) bool {
    if (left.len != right.len) return false;
    for (left, right) |a, b| {
        const lower_a = if (a >= 'A' and a <= 'Z') a + 32 else a;
        const lower_b = if (b >= 'A' and b <= 'Z') b + 32 else b;
        if (lower_a != lower_b) return false;
    }
    return true;
}

/// Reads the next framed body. Returns null on a clean EOF at a frame boundary.
/// The caller owns the returned slice.
pub fn readFrame(reader: *std.Io.Reader, allocator: Allocator) FrameError!?[]u8 {
    var header_buffer: [max_header_bytes]u8 = undefined;
    var header_bytes: usize = 0;
    var content_length: ?usize = null;
    var saw_header = false;

    while (true) {
        const line = (try readHeaderLine(reader, &header_buffer)) orelse {
            if (!saw_header) return null;
            return error.TruncatedHeader;
        };
        saw_header = true;

        header_bytes += line.len + 2;
        if (header_bytes > max_header_bytes) return error.HeaderTooLong;

        if (line.len == 0) break;

        const colon = std.mem.findScalar(u8, line, ':') orelse return error.MalformedHeader;
        const name = line[0..colon];
        const value = line[colon + 1 ..];
        if (eqlIgnoreCase(name, "content-length")) {
            const parsed = try parseContentLength(value);
            if (content_length) |previous| {
                if (previous != parsed) return error.ConflictingContentLength;
            }
            content_length = parsed;
        }
    }

    const body_length = content_length orelse return error.MissingContentLength;
    if (body_length > max_body_bytes) return error.BodyTooLarge;

    const body = allocator.alloc(u8, body_length) catch return error.OutOfMemory;
    errdefer allocator.free(body);
    reader.readSliceAll(body) catch |err| switch (err) {
        error.EndOfStream => return error.TruncatedBody,
        error.ReadFailed => return error.ReadFailed,
    };
    return body;
}

pub fn writeFrame(writer: *std.Io.Writer, body: []const u8) std.Io.Writer.Error!void {
    try writer.print("Content-Length: {d}\r\n\r\n", .{body.len});
    try writer.writeAll(body);
    try writer.flush();
}

pub const RequestId = union(enum) {
    null,
    string: []const u8,
    number: []const u8,
};

pub const Result = struct {
    /// Owned response body, or null when the input was a notification.
    response: ?[]u8,
    shutdown: bool = false,
};

fn writeId(stringify: *std.json.Stringify, id: RequestId) std.json.Stringify.Error!void {
    switch (id) {
        .null => try stringify.write(null),
        .string => |value| try stringify.write(value),
        .number => |value| {
            try stringify.beginWriteRaw();
            try stringify.writer.writeAll(value);
            stringify.endWriteRaw();
        },
    }
}

const ErrorCode = enum(i32) {
    parse = -32700,
    invalid_request = -32600,
    unknown_method = -32601,
    invalid_params = -32602,
    internal = -32603,
};

fn errorMessage(code: ErrorCode) []const u8 {
    return switch (code) {
        .parse => "parse error",
        .invalid_request => "invalid request",
        .unknown_method => "unknown method",
        .invalid_params => "invalid params",
        .internal => "internal error",
    };
}

fn buildError(allocator: Allocator, id: RequestId, code: ErrorCode, detail: []const u8) BuilderError![]u8 {
    var allocating: std.Io.Writer.Allocating = .init(allocator);
    errdefer allocating.deinit();
    var stringify: std.json.Stringify = .{ .writer = &allocating.writer };
    try stringify.beginObject();
    try stringify.objectField("jsonrpc");
    try stringify.write("2.0");
    try stringify.objectField("id");
    try writeId(&stringify, id);
    try stringify.objectField("error");
    try stringify.beginObject();
    try stringify.objectField("code");
    try stringify.print("{d}", .{@backingInt(code)});
    try stringify.objectField("message");
    try stringify.write(errorMessage(code));
    try stringify.objectField("data");
    try stringify.beginObject();
    try stringify.objectField("detail");
    try stringify.write(detail);
    try stringify.endObject();
    try stringify.endObject();
    try stringify.endObject();
    return allocating.toOwnedSlice();
}

pub fn buildFramingError(allocator: Allocator, detail: []const u8) Allocator.Error![]u8 {
    return buildError(allocator, .null, .parse, detail) catch |err| mapBuilderError(err);
}

/// Reports an allocation failure that happened while handling a request. The
/// caller passes the id parsed before the failure so the client can match the
/// error to the pending request. Callers that only have the raw body use
/// `.null`, which the client treats as unattributed.
pub fn buildInternalError(allocator: Allocator, id: RequestId) Allocator.Error![]u8 {
    return buildError(allocator, id, .internal, "allocation failure") catch |err| mapBuilderError(err);
}

fn buildHealth(allocator: Allocator, id: RequestId) BuilderError![]u8 {
    var allocating: std.Io.Writer.Allocating = .init(allocator);
    errdefer allocating.deinit();
    var stringify: std.json.Stringify = .{ .writer = &allocating.writer };
    try stringify.beginObject();
    try stringify.objectField("jsonrpc");
    try stringify.write("2.0");
    try stringify.objectField("id");
    try writeId(&stringify, id);
    try stringify.objectField("result");
    try stringify.beginObject();
    try stringify.objectField("protocolVersion");
    try stringify.print("{d}", .{protocol_version});
    try stringify.objectField("backendVersion");
    try stringify.write(backend_version);
    try stringify.objectField("zigVersion");
    try stringify.write(zig_version);
    try stringify.objectField("capabilities");
    try stringify.beginArray();
    try stringify.write("lex");
    try stringify.endArray();
    try stringify.endObject();
    try stringify.endObject();
    return allocating.toOwnedSlice();
}

fn buildNullResult(allocator: Allocator, id: RequestId) BuilderError![]u8 {
    var allocating: std.Io.Writer.Allocating = .init(allocator);
    errdefer allocating.deinit();
    var stringify: std.json.Stringify = .{ .writer = &allocating.writer };
    try stringify.beginObject();
    try stringify.objectField("jsonrpc");
    try stringify.write("2.0");
    try stringify.objectField("id");
    try writeId(&stringify, id);
    try stringify.objectField("result");
    try stringify.write(null);
    try stringify.endObject();
    return allocating.toOwnedSlice();
}

const DecodedSource = struct {
    utf16le: []const u8,
    units: []const u16,
};

fn decodeSource(arena: Allocator, encoded: []const u8) !DecodedSource {
    const byte_length = std.base64.standard.Decoder.calcSizeForSlice(encoded) catch return error.InvalidBase64;
    if (byte_length % 2 != 0) return error.OddByteCount;
    const bytes = try arena.alloc(u8, byte_length);
    std.base64.standard.Decoder.decode(bytes, encoded) catch return error.InvalidBase64;
    const unit_count = byte_length / 2;
    const units = try arena.alloc(u16, unit_count);
    for (0..unit_count) |index| {
        units[index] = std.mem.readInt(u16, bytes[index * 2 ..][0..2], .little);
    }
    return .{ .utf16le = bytes, .units = units };
}

fn buildLexResult(allocator: Allocator, id: RequestId, params: std.json.Value, arena: Allocator) BuilderError![]u8 {
    const object = switch (params) {
        .object => |value| value,
        else => return buildError(allocator, id, .invalid_params, "params must be an object"),
    };
    const encoded_value = object.get("sourceBase64") orelse
        return buildError(allocator, id, .invalid_params, "missing sourceBase64");
    const encoded = switch (encoded_value) {
        .string => |value| value,
        else => return buildError(allocator, id, .invalid_params, "sourceBase64 must be a string"),
    };
    const encoding_value = object.get("encoding") orelse
        return buildError(allocator, id, .invalid_params, "missing encoding");
    const encoding = switch (encoding_value) {
        .string => |value| value,
        else => return buildError(allocator, id, .invalid_params, "encoding must be a string"),
    };
    if (!std.mem.eql(u8, encoding, "utf16le")) {
        return buildError(allocator, id, .invalid_params, "unknown encoding");
    }

    const decoded = decodeSource(arena, encoded) catch |err| switch (err) {
        error.InvalidBase64 => return buildError(allocator, id, .invalid_params, "invalid base64"),
        error.OddByteCount => return buildError(allocator, id, .invalid_params, "odd byte count"),
        error.OutOfMemory => return error.OutOfMemory,
    };

    const tokens = try lexer.lex(arena, decoded.units);

    var allocating: std.Io.Writer.Allocating = .init(allocator);
    errdefer allocating.deinit();
    var stringify: std.json.Stringify = .{ .writer = &allocating.writer };
    try stringify.beginObject();
    try stringify.objectField("jsonrpc");
    try stringify.write("2.0");
    try stringify.objectField("id");
    try writeId(&stringify, id);
    try stringify.objectField("result");
    try stringify.beginObject();
    try stringify.objectField("tokens");
    try stringify.beginArray();
    for (tokens) |token| {
        const value = lexer.valueBytes(token, decoded.utf16le);
        const encoded_length = std.base64.standard.Encoder.calcSize(value.len);
        const value_buffer = try arena.alloc(u8, encoded_length);
        const encoded_value_bytes = std.base64.standard.Encoder.encode(value_buffer, value);
        try stringify.beginObject();
        try stringify.objectField("kind");
        try stringify.write(token.kind.name());
        try stringify.objectField("valueBase64");
        try stringify.write(encoded_value_bytes);
        try stringify.objectField("start");
        try stringify.print("{d}", .{token.start});
        try stringify.objectField("end");
        try stringify.print("{d}", .{token.end});
        try stringify.objectField("line");
        try stringify.print("{d}", .{token.line});
        try stringify.objectField("character");
        try stringify.print("{d}", .{token.character});
        try stringify.objectField("indent");
        try stringify.print("{d}", .{token.indent});
        try stringify.endObject();
    }
    try stringify.endArray();
    try stringify.endObject();
    try stringify.endObject();
    return allocating.toOwnedSlice();
}

const ParsedId = union(enum) { missing: void, invalid: void, present: RequestId };

/// Bodies are parsed with `parse_numbers = false`, so JSON numbers arrive as
/// arena-owned `number_string` slices and can be echoed without re-formatting.
fn parseId(object: std.json.ObjectMap) ParsedId {
    const value = object.get("id") orelse return .missing;
    return switch (value) {
        .string => |text| .{ .present = .{ .string = text } },
        .number_string => |text| .{ .present = .{ .number = text } },
        else => .invalid,
    };
}

fn handleObject(allocator: Allocator, object: std.json.ObjectMap, arena: Allocator) BuilderError!Result {
    const parsed_id = parseId(object);
    const id = switch (parsed_id) {
        .missing => null,
        .invalid => return .{ .response = try buildError(allocator, .null, .invalid_request, "id must be a string or number") },
        .present => |value| value,
    };

    const is_notification = id == null;
    const request_id = id orelse RequestId.null;

    const method_value = object.get("method") orelse {
        if (is_notification) return .{ .response = null };
        return .{ .response = try buildError(allocator, request_id, .invalid_request, "missing method") };
    };
    const method = switch (method_value) {
        .string => |value| value,
        else => {
            if (is_notification) return .{ .response = null };
            return .{ .response = try buildError(allocator, request_id, .invalid_request, "method must be a string") };
        },
    };

    if (object.get("jsonrpc")) |version_value| {
        const valid = switch (version_value) {
            .string => |value| std.mem.eql(u8, value, "2.0"),
            else => false,
        };
        if (!valid) {
            if (is_notification) return .{ .response = null };
            return .{ .response = try buildError(allocator, request_id, .invalid_request, "jsonrpc must be 2.0") };
        }
    }

    if (is_notification) return .{ .response = null };

    if (std.mem.eql(u8, method, "health")) {
        return .{ .response = try buildHealth(allocator, request_id) };
    }
    if (std.mem.eql(u8, method, "lex")) {
        const params = object.get("params") orelse
            return .{ .response = try buildError(allocator, request_id, .invalid_params, "missing params") };
        return .{ .response = try buildLexResult(allocator, request_id, params, arena) };
    }
    if (std.mem.eql(u8, method, "shutdown")) {
        return .{ .response = try buildNullResult(allocator, request_id), .shutdown = true };
    }
    return .{ .response = try buildError(allocator, request_id, .unknown_method, "unknown method") };
}

/// Rejects empty input, malformed input and trailing JSON values before the
/// dynamic parser runs. `parseFromSliceLeaky` asserts that the scanner has
/// consumed exactly one document; a scanner precondition keeps that assert
/// out of the server's reachable input space.
fn isSingleJsonDocument(arena: Allocator, body: []const u8) !bool {
    var scanner = std.json.Scanner.initCompleteInput(arena, body);
    defer scanner.deinit();

    // `peekNextTokenType` only reads from the complete input; unlike `next`
    // and `skipValue`, it cannot allocate.
    const first = scanner.peekNextTokenType() catch return false;
    if (first == .end_of_document) return false;

    scanner.skipValue() catch |err| switch (err) {
        error.OutOfMemory => return error.OutOfMemory,
        else => return false,
    };
    const trailing = scanner.next() catch |err| switch (err) {
        error.OutOfMemory => return error.OutOfMemory,
        else => return false,
    };
    return trailing == .end_of_document;
}

fn handleBodyInner(allocator: Allocator, body: []const u8, arena: Allocator, id_out: *?RequestId) BuilderError!Result {
    const valid_document = isSingleJsonDocument(arena, body) catch |err| switch (err) {
        error.OutOfMemory => return error.OutOfMemory,
    };
    if (!valid_document) {
        return .{ .response = try buildError(allocator, .null, .parse, "body is not valid JSON") };
    }

    const parsed = std.json.parseFromSliceLeaky(std.json.Value, arena, body, .{
        .parse_numbers = false,
    }) catch |err| switch (err) {
        error.OutOfMemory => return error.OutOfMemory,
        else => return .{ .response = try buildError(allocator, .null, .parse, "body is not valid JSON") },
    };

    switch (parsed) {
        .object => |object| {
            id_out.* = switch (parseId(object)) {
                .present => |value| value,
                .missing, .invalid => null,
            };
            return handleObject(allocator, object, arena);
        },
        else => return .{ .response = try buildError(allocator, .null, .invalid_request, "request must be an object") },
    }
}

/// Handles one frame body. Parse failures produce a `-32700` response and keep
/// the connection usable because the frame boundary is already known.
pub fn handleBody(allocator: Allocator, body: []const u8) Allocator.Error!Result {
    var arena_state = std.heap.ArenaAllocator.init(allocator);
    defer arena_state.deinit();
    var request_id: ?RequestId = null;
    return handleBodyInner(allocator, body, arena_state.allocator(), &request_id) catch |err| switch (err) {
        error.OutOfMemory, error.WriteFailed => {
            const id = request_id orelse RequestId.null;
            const failure = buildInternalError(allocator, id) catch |build_err| return mapBuilderError(build_err);
            return .{ .response = failure };
        },
    };
}

pub fn buildFrame(allocator: Allocator, body: []const u8) Allocator.Error![]u8 {
    var allocating: std.Io.Writer.Allocating = try std.Io.Writer.Allocating.initCapacity(allocator, body.len + 64);
    errdefer allocating.deinit();
    const writer = &allocating.writer;
    writer.print("Content-Length: {d}\r\n\r\n", .{body.len}) catch return error.OutOfMemory;
    writer.writeAll(body) catch return error.OutOfMemory;
    return allocating.toOwnedSlice();
}

test "health request round trip" {
    const body_response = try handleBody(std.testing.allocator, "{\"id\":1,\"method\":\"health\"}");
    defer if (body_response.response) |body| std.testing.allocator.free(body);
    try std.testing.expect(body_response.response != null);
    try std.testing.expect(!body_response.shutdown);
}

test "framing rejects trailing json values" {
    const result = try handleBody(std.testing.allocator, "{} {}");
    defer if (result.response) |body| std.testing.allocator.free(body);
    const body = result.response orelse return error.TestUnexpectedResult;
    try std.testing.expect(std.mem.indexOf(u8, body, "-32700") != null);
}

test "notification has no response" {
    const result = try handleBody(std.testing.allocator, "{\"jsonrpc\":\"2.0\",\"method\":\"health\"}");
    try std.testing.expect(result.response == null);
}

test "parse error keeps id null" {
    const result = try handleBody(std.testing.allocator, "not json");
    defer if (result.response) |body| std.testing.allocator.free(body);
    const body = result.response orelse return error.TestUnexpectedResult;
    try std.testing.expect(std.mem.indexOf(u8, body, "-32700") != null);
    try std.testing.expect(std.mem.indexOf(u8, body, "\"id\":null") != null);
}

test "unknown method is -32601" {
    const result = try handleBody(std.testing.allocator, "{\"id\":7,\"method\":\"nope\"}");
    defer if (result.response) |body| std.testing.allocator.free(body);
    const body = result.response orelse return error.TestUnexpectedResult;
    try std.testing.expect(std.mem.indexOf(u8, body, "-32601") != null);
    try std.testing.expect(std.mem.indexOf(u8, body, "\"id\":7") != null);
}

test "lex round trip" {
    const result = try handleBody(std.testing.allocator, "{\"id\":\"a\",\"method\":\"lex\",\"params\":{\"sourceBase64\":\"dgBhAHIA\",\"encoding\":\"utf16le\"}}");
    defer if (result.response) |body| std.testing.allocator.free(body);
    const body = result.response orelse return error.TestUnexpectedResult;
    try std.testing.expect(std.mem.indexOf(u8, body, "identifier") != null);
    try std.testing.expect(std.mem.indexOf(u8, body, "\"id\":\"a\"") != null);
}

fn expectFrameOk(reader: *std.Io.Reader, expected_body: []const u8) !void {
    const body = (try readFrame(reader, std.testing.allocator)) orelse return error.TestUnexpectedResult;
    defer std.testing.allocator.free(body);
    try std.testing.expectEqualStrings(expected_body, body);
}

fn expectFrameError(reader: *std.Io.Reader, expected: FrameError) !void {
    try std.testing.expectError(expected, readFrame(reader, std.testing.allocator));
}

test "frames accept crlf, lf and mixed line endings" {
    var reader = std.Io.Reader.fixed(
        "Content-Length: 2\r\n\r\n{}" ++
            "Content-Length: 2\n\n[]" ++
            "CONTENT-LENGTH: 2\r\n\r\n{}",
    );
    try expectFrameOk(&reader, "{}");
    try expectFrameOk(&reader, "[]");
    try expectFrameOk(&reader, "{}");
    try std.testing.expect((try readFrame(&reader, std.testing.allocator)) == null);
}

test "frames ignore unknown headers and accept equal duplicates" {
    var reader = std.Io.Reader.fixed(
        "Content-Type: application/json\r\n" ++
            "Content-Length: 2\r\n" ++
            "content-length:  2 \r\n" ++
            "\r\n{}",
    );
    try expectFrameOk(&reader, "{}");
}

test "frames reject conflicting duplicate content length" {
    var reader = std.Io.Reader.fixed("Content-Length: 2\r\nContent-Length: 3\r\n\r\n{}");
    try expectFrameError(&reader, error.ConflictingContentLength);
}

test "frames reject missing and invalid content length" {
    var missing = std.Io.Reader.fixed("Content-Type: application/json\r\n\r\n");
    try expectFrameError(&missing, error.MissingContentLength);

    var text = std.Io.Reader.fixed("Content-Length: two\r\n\r\n");
    try expectFrameError(&text, error.InvalidContentLength);

    var empty = std.Io.Reader.fixed("Content-Length:\r\n\r\n");
    try expectFrameError(&empty, error.InvalidContentLength);

    var negative = std.Io.Reader.fixed("Content-Length: -1\r\n\r\n");
    try expectFrameError(&negative, error.InvalidContentLength);
}

test "frames reject oversized bodies before allocating" {
    var reader = std.Io.Reader.fixed("Content-Length: 16777217\r\n\r\n");
    try expectFrameError(&reader, error.BodyTooLarge);
}

test "frames accept the exact body limit" {
    const header = std.fmt.comptimePrint("Content-Length: {d}\r\n\r\n", .{max_body_bytes});
    var reader = std.Io.Reader.fixed(header);
    try expectFrameError(&reader, error.TruncatedBody);
}

test "frames report truncated headers and bodies" {
    var header = std.Io.Reader.fixed("Content-Length: 2\r\n");
    try expectFrameError(&header, error.TruncatedHeader);

    var body = std.Io.Reader.fixed("Content-Length: 4\r\n\r\n{}");
    try expectFrameError(&body, error.TruncatedBody);
}

test "frames report malformed headers" {
    var no_colon = std.Io.Reader.fixed("Content-Length 2\r\n\r\n");
    try expectFrameError(&no_colon, error.MalformedHeader);
}

test "frames reject header blocks over the limit" {
    var buffer: [max_header_bytes + 16]u8 = undefined;
    @memset(&buffer, 'x');
    var reader = std.Io.Reader.fixed(&buffer);
    try expectFrameError(&reader, error.HeaderTooLong);
}

test "clean eof at a frame boundary returns null" {
    var reader = std.Io.Reader.fixed("");
    try std.testing.expect((try readFrame(&reader, std.testing.allocator)) == null);
}

test "buildFrame emits crlf and a byte exact body" {
    const frame = try buildFrame(std.testing.allocator, "{\"id\":1}");
    defer std.testing.allocator.free(frame);
    try std.testing.expectEqualStrings("Content-Length: 8\r\n\r\n{\"id\":1}", frame);

    var reader = std.Io.Reader.fixed(frame);
    try expectFrameOk(&reader, "{\"id\":1}");
}

test "buildFrame counts multi byte bodies in bytes" {
    const frame = try buildFrame(std.testing.allocator, "\xe4\xbd\xa0\xe5\xa5\xbd");
    defer std.testing.allocator.free(frame);
    try std.testing.expect(std.mem.startsWith(u8, frame, "Content-Length: 6\r\n\r\n"));
}

test "writeFrame emits a parseable frame" {
    var storage: [256]u8 = undefined;
    var writer = std.Io.Writer.fixed(&storage);
    try writeFrame(&writer, "{}");
    var reader = std.Io.Reader.fixed(storage[0..writer.end]);
    try expectFrameOk(&reader, "{}");
}

test "framing error body uses null id and parse code" {
    const body = try buildFramingError(std.testing.allocator, "missing content length");
    defer std.testing.allocator.free(body);
    try std.testing.expect(std.mem.indexOf(u8, body, "-32700") != null);
    try std.testing.expect(std.mem.indexOf(u8, body, "\"id\":null") != null);
}

test "internal error echoes the request id" {
    const body = try buildInternalError(std.testing.allocator, .{ .string = "req-1" });
    defer std.testing.allocator.free(body);
    try std.testing.expect(std.mem.indexOf(u8, body, "-32603") != null);
    try std.testing.expect(std.mem.indexOf(u8, body, "\"id\":\"req-1\"") != null);
}
