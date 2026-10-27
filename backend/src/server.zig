//! Frame loop for the analysis sidecar.
//!
//! The loop owns every frame buffer for exactly one iteration. Framing errors
//! end the process because the next frame boundary is unknowable; body errors
//! answer with an error frame and keep reading from the next boundary.

const std = @import("std");
const Allocator = std.mem.Allocator;

const protocol = @import("protocol.zig");

fn framingDetail(err: protocol.FrameError) []const u8 {
    return switch (err) {
        error.TruncatedHeader => "truncated header",
        error.HeaderTooLong => "header block exceeds the size limit",
        error.MalformedHeader => "malformed header",
        error.MissingContentLength => "missing content length",
        error.InvalidContentLength => "invalid content length",
        error.ConflictingContentLength => "conflicting content length",
        error.BodyTooLarge => "body exceeds the size limit",
        error.TruncatedBody => "truncated body",
        error.ReadFailed => "stdin read failed",
        error.OutOfMemory => "out of memory",
    };
}

fn reportFramingError(allocator: Allocator, writer: *std.Io.Writer, detail: []const u8) std.Io.Writer.Error!void {
    std.debug.print("neo-godot-backend: framing error: {s}\n", .{detail});
    const body = protocol.buildFramingError(allocator, detail) catch {
        std.debug.print("neo-godot-backend: cannot report framing error: out of memory\n", .{});
        return;
    };
    defer allocator.free(body);
    try protocol.writeFrame(writer, body);
}

/// Serves framed requests until shutdown, a framing error or clean stdin EOF.
pub fn run(allocator: Allocator, reader: *std.Io.Reader, writer: *std.Io.Writer) std.Io.Writer.Error!void {
    while (true) {
        const frame = protocol.readFrame(reader, allocator) catch |err| {
            try reportFramingError(allocator, writer, framingDetail(err));
            return;
        };
        const body = frame orelse return;
        defer allocator.free(body);

        const result = protocol.handleBody(allocator, body) catch {
            // `handleBody` reports allocation failures itself once it has the
            // parsed id; this fallback only covers that report failing too.
            const failure = protocol.buildInternalError(allocator, .null) catch {
                std.debug.print("neo-godot-backend: request failed and the error frame could not be built\n", .{});
                return;
            };
            defer allocator.free(failure);
            try protocol.writeFrame(writer, failure);
            continue;
        };

        const response = result.response orelse continue;
        defer allocator.free(response);
        try protocol.writeFrame(writer, response);

        if (result.shutdown) return;
    }
}

test "run exits quietly on clean eof" {
    var reader = std.Io.Reader.fixed("");
    var storage: [64]u8 = undefined;
    var writer = std.Io.Writer.fixed(&storage);
    try run(std.testing.allocator, &reader, &writer);
    try std.testing.expectEqual(@as(usize, 0), writer.end);
}

test "run answers health and keeps reading" {
    var reader = std.Io.Reader.fixed(
        "Content-Length: 27\r\n\r\n{\"id\":1,\"method\":\"health\"}\n" ++
            "Content-Length: 27\r\n\r\n{\"id\":2,\"method\":\"health\"}\n",
    );
    var storage: [1024]u8 = undefined;
    var writer = std.Io.Writer.fixed(&storage);
    try run(std.testing.allocator, &reader, &writer);

    var output = std.Io.Reader.fixed(storage[0..writer.end]);
    var frames: usize = 0;
    while (try protocol.readFrame(&output, std.testing.allocator)) |body| {
        std.testing.allocator.free(body);
        frames += 1;
    }
    try std.testing.expectEqual(@as(usize, 2), frames);
}

test "run reports a framing error and stops" {
    var reader = std.Io.Reader.fixed("Content-Length: nope\r\n\r\n");
    var storage: [512]u8 = undefined;
    var writer = std.Io.Writer.fixed(&storage);
    try run(std.testing.allocator, &reader, &writer);

    var output = std.Io.Reader.fixed(storage[0..writer.end]);
    const body = (try protocol.readFrame(&output, std.testing.allocator)) orelse return error.TestUnexpectedResult;
    defer std.testing.allocator.free(body);
    try std.testing.expect(std.mem.indexOf(u8, body, "-32700") != null);
    try std.testing.expect((try protocol.readFrame(&output, std.testing.allocator)) == null);
}

test "run answers shutdown and stops" {
    var reader = std.Io.Reader.fixed(
        "Content-Length: 29\r\n\r\n{\"id\":3,\"method\":\"shutdown\"}\n" ++
            "Content-Length: 27\r\n\r\n{\"id\":4,\"method\":\"health\"}\n",
    );
    var storage: [512]u8 = undefined;
    var writer = std.Io.Writer.fixed(&storage);
    try run(std.testing.allocator, &reader, &writer);

    var output = std.Io.Reader.fixed(storage[0..writer.end]);
    const body = (try protocol.readFrame(&output, std.testing.allocator)) orelse return error.TestUnexpectedResult;
    defer std.testing.allocator.free(body);
    try std.testing.expect(std.mem.indexOf(u8, body, "\"result\":null") != null);
    try std.testing.expect((try protocol.readFrame(&output, std.testing.allocator)) == null);
}
