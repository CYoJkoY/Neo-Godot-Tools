//! Entry point for the analysis sidecar (Zig 0.17.0).
//!
//! stdout is the protocol stream, so diagnostics use `std.debug.print`, which
//! targets stderr. The process exits after `shutdown`, a framing error or EOF.

const std = @import("std");
const Io = std.Io;

const protocol = @import("protocol.zig");
const server = @import("server.zig");
const symbols = @import("symbol_index.zig");

pub fn main(init: std.process.Init) !void {
    const allocator = init.gpa;
    const io = init.io;

    var stdin_buffer: [4096]u8 = undefined;
    var stdin_reader: Io.File.Reader = .initStreaming(.stdin(), io, &stdin_buffer);

    var stdout_buffer: [4096]u8 = undefined;
    var stdout_file_writer: Io.File.Writer = .initStreaming(.stdout(), io, &stdout_buffer);

    std.debug.print("neo-godot-backend {s} (zig {s}) ready\n", .{ protocol.backend_version, protocol.zig_version });

    var store = symbols.Store.init(allocator);
    defer store.deinit();

    try server.runWithStore(allocator, &stdin_reader.interface, &stdout_file_writer.interface, &store);
}
