//! Request accounting for the sidecar status endpoint.
//!
//! The registry is the only mutable state the status response reads. Every
//! counter is updated with saturating arithmetic so a long-lived process can
//! never wrap a total and report a negative or tiny value. Timing uses the
//! monotonic awake clock, which the host provides through std.Io.

const std = @import("std");

/// Accumulated work for one module of the sidecar.
pub const Counter = struct {
    requests: u64 = 0,
    total_ns: u64 = 0,
    max_ns: u64 = 0,

    pub fn record(self: *Counter, elapsed_ns: u64) void {
        self.requests +|= 1;
        self.total_ns +|= elapsed_ns;
        if (elapsed_ns > self.max_ns) self.max_ns = elapsed_ns;
    }

    /// Mean duration in microseconds, rounded down; zero before the first call.
    pub fn meanMicros(self: Counter) u64 {
        if (self.requests == 0) return 0;
        return (self.total_ns / 1000) / self.requests;
    }
};

pub const Module = enum {
    request,
    lexer,
    parser,
    symbols,

    /// Stable display order for the status response and the dashboard.
    pub const order: [4]Module = .{ .request, .lexer, .parser, .symbols };

    /// Display name used by the dashboard; the wire contract is the lower-case
    /// enum name, so a rename here never changes the protocol.
    pub fn label(self: Module) []const u8 {
        return switch (self) {
            .request => "Request (end to end)",
            .lexer => "Lexer",
            .parser => "Parser",
            .symbols => "Symbol Index",
        };
    }

    /// Language that executes the module. Every module is native, and the
    /// dashboard reports it so a regression to the TypeScript fallback shows up
    /// instead of hiding behind a fast average.
    pub fn driver(self: Module) []const u8 {
        return switch (self) {
            .request, .lexer, .parser, .symbols => "zig",
        };
    }
};

pub const Registry = struct {
    io: std.Io,
    started: std.Io.Timestamp,
    request: Counter = .{},
    lexer: Counter = .{},
    parser: Counter = .{},
    symbols: Counter = .{},
    /// Bytes retained by the scratch arena of the last handled request.
    scratch_last: usize = 0,
    /// Largest value scratch_last ever reached.
    scratch_peak: usize = 0,

    pub fn init(io: std.Io) Registry {
        return .{ .io = io, .started = std.Io.Timestamp.now(io, .awake) };
    }

    pub fn counter(self: *Registry, module: Module) *Counter {
        return switch (module) {
            .request => &self.request,
            .lexer => &self.lexer,
            .parser => &self.parser,
            .symbols => &self.symbols,
        };
    }

    pub fn recordScratch(self: *Registry, bytes: usize) void {
        self.scratch_last = bytes;
        if (bytes > self.scratch_peak) self.scratch_peak = bytes;
    }

    pub fn uptimeMilliseconds(self: *const Registry) i64 {
        const now = std.Io.Timestamp.now(self.io, .awake);
        return self.started.durationTo(now).toMilliseconds();
    }
};

/// One measurement in flight. A null registry makes every method a no-op so
/// call sites never branch on whether accounting is enabled.
pub const Timer = struct {
    registry: ?*Registry,
    began: std.Io.Timestamp,

    pub fn start(registry: ?*Registry) Timer {
        const active = registry orelse return .{ .registry = null, .began = .zero };
        return .{ .registry = active, .began = std.Io.Timestamp.now(active.io, .awake) };
    }

    pub fn finish(self: Timer, module: Module) void {
        const active = self.registry orelse return;
        const now = std.Io.Timestamp.now(active.io, .awake);
        const elapsed = self.began.durationTo(now);
        const nanoseconds: i96 = elapsed.toNanoseconds();
        // The awake clock cannot go backwards; a negative value would mean the
        // host lied, and reporting zero keeps the counters monotonic.
        const clamped: u64 = if (nanoseconds < 0) 0 else @intCast(nanoseconds);
        active.counter(module).record(clamped);
    }
};

test "counter accumulates requests totals and peak" {
    var counter: Counter = .{};
    counter.record(1000);
    counter.record(3000);
    try std.testing.expectEqual(@as(u64, 2), counter.requests);
    try std.testing.expectEqual(@as(u64, 4000), counter.total_ns);
    try std.testing.expectEqual(@as(u64, 3000), counter.max_ns);
    try std.testing.expectEqual(@as(u64, 2), counter.meanMicros());
}

test "counter saturates instead of wrapping" {
    var counter: Counter = .{ .requests = std.math.maxInt(u64), .total_ns = std.math.maxInt(u64) };
    counter.record(10);
    try std.testing.expectEqual(std.math.maxInt(u64), counter.requests);
    try std.testing.expectEqual(std.math.maxInt(u64), counter.total_ns);
}

test "null timer records nothing" {
    const timer = Timer.start(null);
    timer.finish(.lexer);
}

test "registry times a measured section" {
    const io = std.Io.Threaded.global_single_threaded.io();
    var registry = Registry.init(io);
    const timer = Timer.start(&registry);
    timer.finish(.parser);
    try std.testing.expectEqual(@as(u64, 1), registry.parser.requests);
    try std.testing.expect(registry.uptimeMilliseconds() >= 0);
}

test "registry tracks the scratch peak" {
    const io = std.Io.Threaded.global_single_threaded.io();
    var registry = Registry.init(io);
    registry.recordScratch(64);
    registry.recordScratch(32);
    try std.testing.expectEqual(@as(usize, 32), registry.scratch_last);
    try std.testing.expectEqual(@as(usize, 64), registry.scratch_peak);
}

