//! Workspace symbol mirror for the analysis sidecar.
//!
//! The TypeScript index is authoritative. This store keeps a compact copy of
//! the symbol table so queries return an ordered id vector instead of symbol
//! objects, and so completions avoid flattening and sorting every symbol on
//! the extension host thread.

const std = @import("std");
const Allocator = std.mem.Allocator;

/// Printable ASCII punctuation in `Intl.Collator` order. Digits and letters
/// follow this table; both letter cases share one primary rank.
pub const punctuation_order = " _-,;:!?.'\"()[]{}@*/\\&#%`^+<=>|~$";

const digit_base: u8 = @intCast(punctuation_order.len);
const letter_base: u8 = digit_base + 10;

const rank_table: [128]u8 = blk: {
    var table: [128]u8 = @splat(0);
    for (punctuation_order, 0..) |character, index| table[character] = @intCast(index);
    var digit: u8 = 0;
    while (digit < 10) : (digit += 1) table['0' + digit] = digit_base + digit;
    var letter: u8 = 0;
    while (letter < 26) : (letter += 1) {
        table['a' + letter] = letter_base + letter;
        table['A' + letter] = letter_base + letter;
    }
    break :blk table;
};

pub fn isPrintableAscii(value: []const u8) bool {
    for (value) |byte| if (byte < 0x20 or byte > 0x7e) return false;
    return true;
}

fn foldAscii(value: u8) u8 {
    return if (value >= 'A' and value <= 'Z') value + 32 else value;
}

/// Compares two printable ASCII strings with the TypeScript collation rules.
pub fn compareAscii(left: []const u8, right: []const u8) i32 {
    const shared = @min(left.len, right.len);
    var index: usize = 0;
    while (index < shared) : (index += 1) {
        const left_rank = rank_table[left[index]];
        const right_rank = rank_table[right[index]];
        if (left_rank != right_rank) return @as(i32, left_rank) - @as(i32, right_rank);
    }
    if (left.len != right.len) return @as(i32, @intCast(left.len)) - @as(i32, @intCast(right.len));

    index = 0;
    while (index < shared) : (index += 1) {
        if (left[index] == right[index]) continue;
        const left_lower: i32 = if (left[index] >= 'a' and left[index] <= 'z') 0 else 1;
        const right_lower: i32 = if (right[index] >= 'a' and right[index] <= 'z') 0 else 1;
        if (left_lower != right_lower) return left_lower - right_lower;
        return @as(i32, left[index]) - @as(i32, right[index]);
    }
    return 0;
}

pub const StoreError = error{ OutOfMemory, InvalidInput, RevisionMismatch };

pub const SymbolInput = struct {
    name: []const u8,
    start: u64,
    end: u64,
};

pub const FileInput = struct {
    uri: []const u8,
    symbols: []const SymbolInput,
};

pub const Digest = struct {
    revision: i64,
    files: usize,
    symbols: usize,
};

const Entry = struct {
    id: u32,
    name: []u8,
    folded: []u8,
    uri: []u8,
    start: u64,
    end: u64,
};

pub const Store = struct {
    allocator: Allocator,
    entries: std.ArrayList(Entry) = .empty,
    files: std.StringHashMap(std.ArrayList(u32)),
    by_id: std.AutoHashMap(u32, usize),
    order: std.ArrayList(u32) = .empty,
    revision: i64 = 0,
    next_id: u32 = 1,
    sorted: bool = true,

    pub fn init(allocator: Allocator) Store {
        return .{
            .allocator = allocator,
            .files = std.StringHashMap(std.ArrayList(u32)).init(allocator),
            .by_id = std.AutoHashMap(u32, usize).init(allocator),
        };
    }

    pub fn deinit(self: *Store) void {
        for (self.entries.items) |entry| self.freeEntry(entry);
        self.entries.deinit(self.allocator);
        var iterator = self.files.iterator();
        while (iterator.next()) |item| {
            self.allocator.free(item.key_ptr.*);
            item.value_ptr.deinit(self.allocator);
        }
        self.files.deinit();
        self.by_id.deinit();
        self.order.deinit(self.allocator);
    }

    pub fn digest(self: *const Store) Digest {
        return .{ .revision = self.revision, .files = self.files.count(), .symbols = self.entries.items.len };
    }

    pub fn currentRevision(self: *const Store) i64 {
        return self.revision;
    }

    /// Ids retained for one file, in input order. The slice is owned by the
    /// store and stays valid until that file is replaced, removed or cleared.
    pub fn fileIds(self: *const Store, uri: []const u8) ?[]const u32 {
        const ids = self.files.get(uri) orelse return null;
        return ids.items;
    }

    fn freeEntry(self: *Store, entry: Entry) void {
        self.allocator.free(entry.name);
        self.allocator.free(entry.folded);
        self.allocator.free(entry.uri);
    }

    fn entryById(self: *const Store, id: u32) ?*const Entry {
        const index = self.by_id.get(id) orelse return null;
        return &self.entries.items[index];
    }

    fn dropEntry(self: *Store, id: u32) void {
        const index = self.by_id.fetchRemove(id) orelse return;
        const entry = self.entries.items[index.value];
        self.freeEntry(entry);
        _ = self.entries.swapRemove(index.value);
        if (index.value < self.entries.items.len) {
            const moved = self.entries.items[index.value];
            // The map just lost one entry, so its capacity already covers a
            // reinsertion and the non-failing path is the correct one here.
            self.by_id.putAssumeCapacity(moved.id, index.value);
        }
        self.sorted = false;
    }

    fn dropFile(self: *Store, uri: []const u8) void {
        const removed = self.files.fetchRemove(uri) orelse return;
        self.allocator.free(removed.key);
        var ids = removed.value;
        defer ids.deinit(self.allocator);
        for (ids.items) |id| self.dropEntry(id);
    }

    fn putEntry(self: *Store, file_uri: []const u8, symbol: SymbolInput, ids: *std.ArrayList(u32)) StoreError!void {
        if (self.next_id == std.math.maxInt(u32)) return error.OutOfMemory;
        const name = try self.allocator.dupe(u8, symbol.name);
        errdefer self.allocator.free(name);
        const uri = try self.allocator.dupe(u8, file_uri);
        errdefer self.allocator.free(uri);
        const folded = try self.allocator.alloc(u8, symbol.name.len);
        errdefer self.allocator.free(folded);
        for (symbol.name, 0..) |byte, index| folded[index] = foldAscii(byte);

        const id = self.next_id;
        self.next_id += 1;
        try self.entries.append(self.allocator, .{
            .id = id,
            .name = name,
            .folded = folded,
            .uri = uri,
            .start = symbol.start,
            .end = symbol.end,
        });
        errdefer _ = self.entries.pop();
        try self.by_id.put(id, self.entries.items.len - 1);
        errdefer _ = self.by_id.remove(id);
        try ids.append(self.allocator, id);
        self.sorted = false;
    }

    /// Replaces every symbol of one file. Ids are assigned in input order so
    /// the TypeScript mirror can map the returned vector back to its objects.
    pub fn ingest(self: *Store, revision: i64, files: []const FileInput) StoreError!void {
        try self.expectNewer(revision);
        for (files) |file| {
            if (!isPrintableAscii(file.uri)) return error.InvalidInput;
            for (file.symbols) |symbol| {
                if (!isPrintableAscii(symbol.name)) return error.InvalidInput;
            }
        }

        for (files) |file| {
            self.dropFile(file.uri);
            const owned_uri = try self.allocator.dupe(u8, file.uri);
            errdefer self.allocator.free(owned_uri);
            var ids: std.ArrayList(u32) = .empty;
            errdefer ids.deinit(self.allocator);
            for (file.symbols) |symbol| try self.putEntry(file.uri, symbol, &ids);
            try self.files.put(owned_uri, ids);
        }
        self.revision = revision;
    }

    pub fn remove(self: *Store, revision: i64, uri: []const u8) StoreError!void {
        try self.expectNewer(revision);
        if (!isPrintableAscii(uri)) return error.InvalidInput;
        self.dropFile(uri);
        self.revision = revision;
    }

    /// Mutations must advance the revision, so two clients sharing one sidecar
    /// cannot overwrite a newer table with a copy built from an older one.
    fn expectNewer(self: *const Store, revision: i64) StoreError!void {
        if (revision <= self.revision) return error.RevisionMismatch;
    }

    pub fn clear(self: *Store, revision: i64) StoreError!void {
        try self.expectNewer(revision);
        for (self.entries.items) |entry| self.freeEntry(entry);
        self.entries.clearRetainingCapacity();
        var iterator = self.files.iterator();
        while (iterator.next()) |item| {
            self.allocator.free(item.key_ptr.*);
            item.value_ptr.deinit(self.allocator);
        }
        self.files.clearRetainingCapacity();
        self.by_id.clearRetainingCapacity();
        self.order.clearRetainingCapacity();
        self.next_id = 1;
        self.revision = revision;
        self.sorted = true;
    }

    fn lessThan(self: *const Store, left_id: u32, right_id: u32) bool {
        const left = self.entryById(left_id) orelse return false;
        const right = self.entryById(right_id) orelse return true;
        const by_name = compareAscii(left.name, right.name);
        if (by_name != 0) return by_name < 0;
        const by_uri = compareAscii(left.uri, right.uri);
        if (by_uri != 0) return by_uri < 0;
        if (left.start != right.start) return left.start < right.start;
        return left_id < right_id;
    }

    fn ensureSorted(self: *Store) StoreError!void {
        if (self.sorted) return;
        try self.order.ensureTotalCapacity(self.allocator, self.entries.items.len);
        self.order.clearRetainingCapacity();
        for (self.entries.items) |entry| self.order.appendAssumeCapacity(entry.id);
        std.mem.sort(u32, self.order.items, self, lessThan);
        self.sorted = true;
    }

    /// Appends ids whose folded name contains the folded query, in workspace
    /// order. The caller owns `out`.
    pub fn query(
        self: *Store,
        allocator: Allocator,
        revision: i64,
        needle: []const u8,
        out: *std.ArrayList(u32),
    ) StoreError!void {
        if (revision != self.revision) return error.RevisionMismatch;
        if (!isPrintableAscii(needle)) return error.InvalidInput;
        try self.ensureSorted();

        const folded = try allocator.alloc(u8, needle.len);
        defer allocator.free(folded);
        for (needle, 0..) |byte, index| folded[index] = foldAscii(byte);

        for (self.order.items) |id| {
            const entry = self.entryById(id) orelse continue;
            if (folded.len == 0 or std.mem.indexOf(u8, entry.folded, folded) != null) {
                try out.append(allocator, id);
            }
        }
    }
};

fn expectInput(name: []const u8, start: u64) SymbolInput {
    return .{ .name = name, .start = start, .end = start + name.len };
}

test "collation matches the typescript probe set" {
    try std.testing.expect(compareAscii("script_10", "script_2") < 0);
    try std.testing.expect(compareAscii("get_value", "getValue") < 0);
    try std.testing.expect(compareAscii("HTTPRequest", "http_request") > 0);
    try std.testing.expect(compareAscii("__init__", "_init") < 0);
    try std.testing.expect(compareAscii("I", "i") > 0);
    try std.testing.expect(compareAscii("same", "same") == 0);
    // Lowercase wins the tertiary weight, matching ICU.
    try std.testing.expect(compareAscii("A", "a") > 0);
}

test "ascii validation rejects control and non ascii bytes" {
    try std.testing.expect(isPrintableAscii("player_health"));
    try std.testing.expect(!isPrintableAscii("\xe4\xbd\xa0\xe5\xa5\xbd"));
    try std.testing.expect(!isPrintableAscii("a\nb"));
}

test "store ingests, replaces and queries in workspace order" {
    var store = Store.init(std.testing.allocator);
    defer store.deinit();

    const first = [_]SymbolInput{ expectInput("script_10", 10), expectInput("script_2", 20) };
    const second = [_]SymbolInput{expectInput("getValue", 5)};
    try store.ingest(1, &.{
        .{ .uri = "file:///a.gd", .symbols = &first },
        .{ .uri = "file:///b.gd", .symbols = &second },
    });

    var ids: std.ArrayList(u32) = .empty;
    defer ids.deinit(std.testing.allocator);
    try store.query(std.testing.allocator, 1, "script", &ids);
    try std.testing.expectEqual(@as(usize, 2), ids.items.len);
    try std.testing.expectEqual(@as(u32, 1), ids.items[0]);
    try std.testing.expectEqual(@as(u32, 2), ids.items[1]);

    try std.testing.expectError(error.RevisionMismatch, store.query(std.testing.allocator, 0, "", &ids));
}

test "store removes files and clears" {
    var store = Store.init(std.testing.allocator);
    defer store.deinit();

    const symbols = [_]SymbolInput{expectInput("alpha", 0)};
    try store.ingest(1, &.{.{ .uri = "file:///a.gd", .symbols = &symbols }});
    try store.remove(2, "file:///a.gd");
    var ids: std.ArrayList(u32) = .empty;
    defer ids.deinit(std.testing.allocator);
    try store.query(std.testing.allocator, 2, "", &ids);
    try std.testing.expectEqual(@as(usize, 0), ids.items.len);

    try store.ingest(3, &.{.{ .uri = "file:///b.gd", .symbols = &symbols }});
    try store.clear(4);
    try std.testing.expectEqual(@as(usize, 0), store.digest().symbols);
    try store.query(std.testing.allocator, 4, "", &ids);
    try std.testing.expectEqual(@as(usize, 0), ids.items.len);
}

test "store rejects revisions that do not advance" {
    var store = Store.init(std.testing.allocator);
    defer store.deinit();

    const symbols = [_]SymbolInput{expectInput("alpha", 0)};
    try std.testing.expectError(error.RevisionMismatch, store.ingest(0, &.{.{ .uri = "file:///a.gd", .symbols = &symbols }}));
    try store.ingest(1, &.{.{ .uri = "file:///a.gd", .symbols = &symbols }});
    try std.testing.expectError(error.RevisionMismatch, store.ingest(1, &.{.{ .uri = "file:///b.gd", .symbols = &symbols }}));
    try std.testing.expectError(error.RevisionMismatch, store.remove(1, "file:///a.gd"));
    try std.testing.expectError(error.RevisionMismatch, store.clear(1));
    // A rejected mutation leaves the previous table untouched.
    try std.testing.expectEqual(@as(usize, 1), store.digest().files);
    try std.testing.expectEqual(@as(i64, 1), store.currentRevision());
}
