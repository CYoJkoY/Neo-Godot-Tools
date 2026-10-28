//! Test root for the backend build. Importing each module makes its test
//! blocks reachable, which lifts them out of lazy analysis.

test {
    _ = @import("lexer.zig");
    _ = @import("protocol.zig");
    _ = @import("server.zig");
    _ = @import("symbol_index.zig");
}
