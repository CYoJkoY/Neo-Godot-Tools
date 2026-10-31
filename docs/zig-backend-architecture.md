# Zig Backend Architecture

Status: implemented for the bootstrap slice, the workspace symbol mirror and the native declaration
parser. The Zig 0.17.0 sidecar serves `health`, `lex`, `parse`, `shutdown` and the `symbols/*` family,
and its Windows and Linux x64 binaries ship inside the VSIX. Workspace symbol queries and global
completions answer from the sidecar when it is available, and the adapter exposes `parse` as an
opt-in call. Every provider still runs on the existing TypeScript analysis path.

This document is the contract for moving the GDScript analysis core into a native Zig 0.17.0 process.
It defines the process lifecycle, the wire protocol, the offset model, the failure semantics and the
migration order. Anything not stated here is out of scope for the current phase.

## Scope and non-goals

The extension keeps a thin TypeScript adapter because VS Code APIs (providers, webviews, debugger
sessions, configuration, extension lifecycle) are a JavaScript surface. Zig owns the algorithms that
walk GDScript source: lexing, parsing, semantic indexing, queries and the formatter.

The first slice deliberately did not change user-visible behaviour. The symbol mirror keeps that
property: no configuration key is added, no default changes, the returned symbol order is the same
order the TypeScript index produced, and the Godot language server remains the fallback for semantics
the local model cannot establish safely. The TypeScript lexer, parser and symbol index stay in place
as the reference implementation and as the fallback path.

Explicitly out of scope for the current phase:

- the native semantic index for every query, the formatter, scene and resource parsing, debug protocol
  and the Godot LSP bridge;
- persistent state, caches on disk, or background project scans;
- code signing, Marketplace signing, and packaged builds for platforms other than Windows x64 and
  Linux x64;
- multi-workspace hosting. The design target is one sidecar per workspace folder to keep the failure
  domain small; the current adapter owns one process per adapter instance and does not pool processes
  across workspaces.

## Why a sidecar

The analysis core is CPU-bound and allocation-heavy. Running it in the extension host ties every parse
to the single JavaScript thread that also serves the editor UI, and a crash takes the extension down
with it. A separate process gives the core its own thread, its own arena allocators and a hard failure
boundary: if the sidecar dies, the adapter restarts it and the TypeScript path answers until the new
process is healthy.

The sidecar is a local child process, never a network service. It binds no port, opens no socket and
expects no inbound connection.

## Process model

```text
VS Code extension host (TypeScript)
        |
        |  stdin  : Content-Length framed JSON-RPC request
        |  stdout : Content-Length framed JSON-RPC response
        |  stderr : human-readable diagnostics only
        v
neo-godot-backend (Zig 0.17.0, one process per adapter instance)
```

One long-lived process per adapter instance. The adapter starts it lazily on the first request, keeps
it for the lifetime of the adapter, and stops it on extension deactivation. The design target is one
process per workspace folder; adapters are not pooled across workspaces yet. The process is spawned
with `stdio: ["pipe", "pipe", "pipe"]` so the extension host controls all three streams.

Rules that follow from the transport:

- stdout carries protocol frames and nothing else. A stray `print` corrupts the stream, so the backend
  never logs to stdout; diagnostics go to stderr and are surfaced through the extension output
  channel.
- stdin EOF means the adapter is gone; the backend exits with code 0 without emitting an error frame.
- stderr is best-effort. The adapter drains it so a chatty child cannot block on a full pipe, but the
  protocol contract never depends on it.

### Lifecycle

1. The adapter resolves the executable, spawns it and attaches stream readers.
2. The adapter sends `health` and waits with a bounded timeout. Any response that does not advertise a
   compatible `protocolVersion` marks the backend unusable for this session.
3. Requests are multiplexed by id. The adapter may have many in flight; the backend answers in
   completion order.
4. `$/cancelRequest` is a notification. The bootstrap backend accepts it and ignores it; the adapter
   still drops the pending promise locally so a cancelled request never resolves a provider.
5. On deactivation the adapter sends `shutdown`, waits briefly for the response, then sends `exit`
   semantics by closing stdin. If the process has not exited after a short grace period it is killed.
6. If the process exits unexpectedly, every pending request rejects with a single `backend exited`
   error, the adapter marks the backend unavailable, and the next request attempts one respawn.

Restarts are bounded: a crash loop that exceeds the retry budget disables the sidecar for the rest of
the session and leaves the TypeScript path in charge. The adapter never spawns from inside a tight
retry loop without a delay.

### Version handshake

`health` is the only mandatory method. It returns:

```json
{
  "protocolVersion": 1,
  "backendVersion": "0.3.0",
  "zigVersion": "0.17.0",
  "capabilities": ["lex", "parse", "symbols"]
}
```

The adapter treats `protocolVersion` as exact-match for now: mixing 1 with 2 is a protocol error, not a
negotiation. `capabilities` lets a newer backend advertise methods the adapter may call conditionally,
so adding a method does not require a protocol bump. `zigVersion` is informational; the compiler that
built the binary is recorded in CI, not inferred at runtime.

`parse` is advertised by every current build and requires no state. `symbols` is advertised only by a
process that owns a workspace symbol store, which is every process spawned by `src/main.zig`. The
capability list stays `["lex", "parse"]` for a stateless server, so a test or an embedder that runs the
request path without a store cannot be told to call `symbols/*`. Capabilities are recorded during the
handshake and cleared when that process exits, so a restarted sidecar is re-interrogated instead of
inheriting the previous answer.

The adapter records `parse` but still requires only `lex` to accept a handshake. `parse()` checks the
recorded capability after startup and rejects with `Zig backend does not advertise the parse
capability.` instead of sending a request that an older binary would answer with `-32601`. A backend
from before 0.3.0 therefore keeps serving `lex` while the caller falls back to `parseGDScript`.

## Framing

Messages use the language-server header format: ASCII headers, a blank line, then a UTF-8 JSON body.

```text
Content-Length: 42\r\n
\r\n
{"jsonrpc":"2.0","id":1,"method":"health"}
```

Rules:

- `Content-Length` is required and byte-exact. It counts body bytes, not characters.
- Header names are matched case-insensitively. Unknown headers are ignored for forward compatibility.
- Both `\r\n` and `\n` terminate header lines and the blank separator line; writers always emit `\r\n`.
- A frame body may be at most 16 MiB (`16 * 1024 * 1024`). A larger `Content-Length` is a framing
  error: emit one structured error and close.
- A missing or non-numeric `Content-Length`, or a header block over 8 KiB, is a framing error. There is
  no way to resynchronise a stream whose length is unknown, so the process exits.
- A framing error is reported as JSON-RPC parse error `-32700` with `id: null`, then the process exits.
- Multiple frames may arrive in one read and one frame may span many reads; the reader must not assume
  that a read boundary aligns with a frame boundary.
- Each response is written and flushed before the reader blocks again. Batching would add latency for
  no throughput gain on small messages.

## Message shape

Requests follow JSON-RPC 2.0. The `jsonrpc` field is emitted as `"2.0"` on every message and accepted on
input; a missing version is tolerated for local adapters but never produced by us.

Request:

```json
{"jsonrpc":"2.0","id":7,"method":"lex","params":{"sourceBase64":"...","encoding":"utf16le"}}
```

Success:

```json
{"jsonrpc":"2.0","id":7,"result":{"tokens":[]}}
```

Error:

```json
{"jsonrpc":"2.0","id":7,"error":{"code":-32602,"message":"invalid params","data":{"detail":"unknown encoding"}}}
```

Error codes are the JSON-RPC set:

| Code | Meaning |
| --- | --- |
| `-32700` | parse error: body is not JSON |
| `-32600` | invalid request: wrong shape, missing method, bad id type |
| `-32601` | unknown method |
| `-32602` | invalid params: missing field, wrong type, bad base64, unknown encoding |
| `-32603` | internal error: allocation failure or an unexpected backend fault |

An error carries the request id when the id could be read; a parse error with no recoverable id uses
`null`. Notifications (no `id`) are never answered, including when they fail.

### Request ids

Ids are strings or numbers as produced by the adapter; the backend echoes them verbatim. The adapter
generates monotonically increasing integers, so number ids are the normal case and string ids exist
only because the protocol permits them. Ids are scoped to a connection; a respawn invalidates every
pending id.

## UTF-16 offset contract

VS Code positions are UTF-16 code units, not code points and not bytes. The backend must produce the
same numbers as JavaScript `String.prototype.length` and `slice`. Two consequences shape the wire
format:

1. Source text crosses the boundary as base64 of UTF-16LE code units. Passing UTF-8 would force a
   conversion that can silently change offsets for non-BMP text and isolated surrogates.
2. Token values come back the same way (`valueBase64`), so the adapter can rebuild the exact JavaScript
   string, including lone surrogates, without a lossy JSON decode.

The JSON envelope is never used to carry GDScript text or token values directly. Metadata such as
methods, ids and error codes is plain ASCII JSON.

Every offset in a token (`start`, `end`, `character`) counts UTF-16 code units. `line` is zero-based and
is not affected by CRLF: a CRLF pair is one newline token and advances the line by one.

Surrogate pairs occupy two code units. The lexer never decodes them; it copies code units, which is why
the Zig implementation stores the decoded source as `[]const u16` and mirrors the JavaScript slicing
rules exactly.

## The `lex` method

`lex` is a differential-tested reimplementation of `src/analyzer/lexer.ts`. Its contract is the token
stream that the existing parser consumes, including quirks that the parser relies on. It is not a
cleaner lexer and must not "fix" observable token shapes.

Params:

```json
{"sourceBase64":"<base64 of UTF-16LE code units>","encoding":"utf16le"}
```

Result:

```json
{"tokens":[{"kind":"identifier","valueBase64":"...","start":0,"end":4,"line":0,"character":0,"indent":0}]}
```

Kind is one of `identifier`, `number`, `string`, `operator`, `punctuation`, `newline`, `eof`.

Behavioural requirements, all inherited from the TypeScript lexer:

- identifiers start with `_`, `A-Z` or `a-z` and continue with those plus digits;
- numbers start with a digit and continue with identifier characters or `.`;
- `#` starts a comment that runs to the next CR or LF and produces no token;
- CRLF and bare LF/CR each produce one `newline` token valued `"\n"`;
- leading spaces and tabs on a line advance both `indent` and `character`; other whitespace advances
  only `character`;
- three-character operators are tried before two-character ones;
- `\` inside a string escapes the next code unit, including a quote or a newline;
- an unescaped CR or LF ends a string without consuming it;
- an unknown code unit is consumed silently;
- the final token is `eof` with an empty value and `start == end == source length`;
- the whitespace `indent` of the current line is copied to every token, and to `eof`.

The last point has a sharp edge worth stating: a backslash at the very end of a string consumes two code
units, so `end` and `character` can run past the source length. The token value is still clipped to the
source. The Zig implementation reproduces the numeric overshoot because the TypeScript parser asserts on
token positions and the two implementations must agree before any provider switch.

## The `parse` method

`parse` is a differential-tested reimplementation of `src/analyzer/parser.ts`, which stays the contract
and the fallback. It covers the declaration level of that parser: the top-level cursor, nested classes,
enums, annotations, parameters, `extends`, function body ranges and the diagnostics the TypeScript
implementation reports. It is not an expression Pratt parser, and it does not add an AST the TypeScript
model lacks.

Params:

```json
{"sourceBase64":"<base64 of UTF-16LE code units>","encoding":"utf16le"}
```

Result:

```json
{
  "strings": ["<base64 of UTF-16LE code units>", "..."],
  "ast": {
    "kind": "script",
    "range": {"start": {"offset": 0, "line": 0, "character": 0}, "end": {"offset": 0, "line": 0, "character": 0}},
    "declarations": []
  },
  "diagnostics": []
}
```

The response keeps text out of the JSON body. Every string field in `ast` is an index into `strings`,
and each table entry is base64 of UTF-16LE code units, so lone surrogates and non-BMP text survive the
round trip unchanged. The table is a compact index over the request's UTF-16 units; it does not dedupe.
Diagnostic messages are interned after all AST fields, and `diagnostics[i].message` is the index of the
i-th appended message rather than an index the AST could collide with. `diagnostics[i].severity` is
always `error`, matching every diagnostic the TypeScript parser produces.

Optional fields are explicit. `name`, `type`, `value`, `defaultValue`, `returnType`, `extendsName` and
`members[i].value` are `null` when the TypeScript node has no such property value, and `bodyRange` is
`null` for a function without an indented body. Enum declarations use `"kind":"enum"`; anonymous enums
still carry a `nameOffset` field set to `null`. Every declaration other than `extends` carries
`nameOffset`, and `extends` omits the field entirely, so the adapter can reject a response that adds a
key the TypeScript AST would not have.

The adapter rebuilds the JavaScript object with the same key set, including keys whose value is
`undefined`, which keeps `assert.deepEqual` against `parseGDScript` exact. A response with a missing
field, an out-of-range string index, or an unrecognised kind rejects with
`Zig backend returned a malformed parse result.`; it never throws out of the promise chain.

Inner classes are limited to 256 levels. The parser recurses once per class, and `std.json.Stringify`
in a safety-checked build keeps a fixed 256-entry nesting stack where each class costs two entries, so
an unbounded source could abort the process inside the encoder. `parse` returns JSON-RPC `-32602` with
the detail `class nesting exceeds the parser limit` for deeper input, leaves the process alive, and
the caller can retry the same source through `parseGDScript`, which does not enforce this limit.

The AST encoder starts a fresh `std.json.Stringify` for every subtree below 48 class levels and embeds
it with `beginWriteRaw`, which keeps wire bytes identical while making encoder depth independent of
source depth. The 60-level protocol test and the 100-level differential case exercise the handoff.

`parse` is opt-in. No provider calls it yet, and the default analysis path remains the TypeScript
parser, so a native bug can cost at most the caller that asked for it.

## The `symbols` family

`symbols/*` is the first provider integration. The sidecar keeps a compact copy of the workspace symbol
table so a query returns an ordered id vector instead of symbol objects, and the extension host never
flattens, filters and sorts the whole index on its own thread.

`src/index/symbol_index.ts` stays authoritative. It owns the `IndexedSymbol` objects, the provider
payloads and the observable order. The native store only answers "which ids match, in what order"; the
TypeScript mirror maps those ids back to the objects the index already holds.

### Methods

| Method | Params | Result |
| --- | --- | --- |
| `symbols/digest` | none | `{"revision":N,"files":F,"symbols":S}` |
| `symbols/ingest` | `{"revision":N,"files":[{"uri":"...","symbols":[{"name":"...","start":0,"end":5}]}]}` | `{"revision":N,"files":[{"uri":"...","idsBase64":"..."}]}` |
| `symbols/remove` | `{"revision":N,"uri":"..."}` | `{"revision":N}` |
| `symbols/query` | `{"revision":N,"query":"..."}` | `{"revision":N,"idsBase64":"..."}` |
| `symbols/clear` | `{"revision":N}` | `{"revision":N}` |

`ingest` replaces every symbol of each named file and leaves other files alone. Ids in the result are
listed in input order, so the caller can pair the i-th id with the i-th symbol it sent without a second
key on the wire. An empty `symbols` array removes that file's symbols while keeping the file known.

Ids are stored as unsigned 32-bit integers and cross the boundary as standard base64 of little-endian
u32 words. The adapter decodes them into a `Uint32Array`, which is compact enough to compare and index
without allocating one object per symbol.

### Revisions

The store carries one revision per sidecar process. Every mutation (`ingest`, `remove`, `clear`) must
send a revision strictly greater than the revision the store currently holds, and a query must name the
current revision exactly. A mutation that does not advance returns `-32602` with `"stale revision"` and
leaves the table untouched; a query against an older or newer revision fails the same way.

The revision exists because the store is shared by every client connected to one sidecar process: two
clients both counting from zero would let a table rebuilt for one workspace overwrite a newer one. The
mirror therefore reads `symbols/digest` before it rebuilds and starts from
`max(server revision, tracked revision) + 1`, retries once from a fresh resync when a mutation loses a
race, and drops a query result whose revision changed while the request was in flight.

### Input restrictions

`uri` and `name` must be printable ASCII (`0x20` to `0x7e`). A control byte or a non-ASCII byte is
rejected with `-32602` and the table is left alone. This keeps the native comparator exact: ASCII case
folding and the punctuation table below cover the whole input domain, so no locale data can change the
order inside the store.

### Ordering

`workspaceSymbols(query)` in the TypeScript index sorts with `Intl.Collator`, and that order is visible
in the Quick Pick list and in the completion list. The native comparator reproduces it for printable
ASCII:

1. punctuation ordered as `` _-,;:!?.'"()[]{}@*/\&#%`^+<=>|~$ ``, then `0`-`9`, then letters with both
   cases sharing one primary rank;
2. shorter prefix first when one string is a prefix of the other;
3. lowercase before uppercase at the first differing position;
4. the remaining code unit order.

Ties on name fall back to `uri`, then `start`, then the id, which makes the order total. Matching is a
case-insensitive substring test on the ASCII-folded name; an empty query matches every symbol.

ICU data differs between hosts, so `src/index/ascii_collation.ts` compares the host `Intl.Collator`
with the native comparator on a probe set before the fast path is enabled. A host that disagrees, for
example `tr-TR` where `I` and `i` do not match, keeps the TypeScript path for the session. The probe
runs once and is cached.

### Mirror lifecycle

`src/index/zig_symbol_mirror.ts` sits between `LanguageService` and the sidecar:

- it observes `upsert`, `remove` and `clear` from the language service and debounces one flush per 16 ms;
- a flush packs files into requests of at most 2048 files and about 8 MiB of estimated JSON, measured as
  48 bytes plus the name length per symbol and 32 bytes plus the uri length per file, which is an upper
  bound for printable ASCII;
- more than 64 individual removals trigger one resync instead of one request per uri;
- a resync reads the digest, clears the table at a newer revision, ingests every file in batches and
  then verifies `files` and `symbols` against the snapshot before marking the copy synchronized;
- an edit that arrives while a request is in flight keeps its newer stamp and is sent again next round,
  and a single file larger than one request disables the mirror instead of truncating it;
- the mirror stores the symbols `SymbolIndex` captured, so a body edit that shifts a declaration leaves
  the mirrored range unchanged until the next API change, which is what the index answers with.

The mirror answers `undefined` whenever it cannot prove the native table matches the index: binary
missing, capability absent, host collation disagreeing, non-ASCII name or uri, oversized file, a failed
flush, or a query that exceeded the 150 ms budget. Every caller then uses the synchronous TypeScript
index, which is what produced the answer before this change.

Cached query results are only served while no upsert or removal is pending, because the native table
lags the index by up to one flush. The cache holds 128 entries and is cleared on every table change, so
it cannot grow with the size of the workspace.

### Consumers

- `WorkspaceSymbolProvider` returns a promise only when a mirror is attached; without one it still
  answers synchronously from the index.
- Global completion (`prefix` without a preceding `.` or `(`) queries the mirror for the current word and
  passes the ordered table into `SemanticQueryEngine.getCompletionsWithWorkspace`. Member completions skip
  the mirror entirely. A count check on workspace names replaces the previous linear `some` scan per
  builtin.

The completion path deliberately does not write the semantic cache from a mirrored result. That cache is
keyed by the synchronous index state, and a table one flush behind would poison it for later requests.

## Cancellation

`$/cancelRequest` carries `{"id": <target>}`. `lex`, `parse` and every `symbols/*` call are synchronous
and short, so the backend acknowledges the notification by doing nothing. The adapter removes the
pending entry and stops waiting; the late response is dropped by id, which keeps the connection usable.
The mirror adds its own budget on top: a query gives the flush 150 ms and falls back to the TypeScript
index when that expires, so a stuck sidecar delays one keystroke at most.

When longer methods arrive, cancellation becomes cooperative: the server keeps a cancel flag per
in-flight request, checks it between work units, and answers `-32800` (request cancelled). That code is
reserved now so the client can already handle it.

## Snapshots and versioning

Nothing semantic is persisted in this slice; the symbol table lives in the sidecar's process memory and
is lost on exit. It is rebuilt from the TypeScript snapshot after a restart. When document snapshots
arrive as source text, the rule is:

- the adapter sends the full text plus a monotonically increasing document version for the file;
- the backend keeps an in-memory snapshot keyed by version and rejects a stale write instead of
  applying it;
- queries name the version they were resolved against, so a provider can discard a result computed for
  an older buffer;
- snapshots are dropped on shutdown and are never written to disk.

This matches the existing TypeScript index, which already guards against stale asynchronous reads by
preferring newer in-memory state.

## Godot LSP fallback

The Godot language server is a separate TCP dependency and stays in TypeScript for now. Routing it
through the sidecar would add a process hop to every fallback request while the fallback still needs
VS Code cancellation semantics. The adapter keeps the existing `LanguageService` fallback behaviour
unchanged.

## Security and trust

The backend is spawned from an extension-controlled path, not from `$PATH`, and it never evaluates
GDScript. It parses text. Frame length limits bound memory per message; the sidecar has no file system
access requirement in this slice and no network access.

The packaged binary is resolved relative to the extension install directory, with development-only
fallback candidates that point at the build output. An environment override
(`NEO_GODOT_TOOLS_ZIG_BACKEND`) exists for development and CI only; an untrusted workspace setting must
never choose the executable path.

## Packaging and release matrix

The binaries are built from source in CI and by `npm run build:backend` locally. They are not committed.

| Platform | Target | Artifact |
| --- | --- | --- |
| Windows x64 | `x86_64-windows` | `backend/zig-out/bin/neo-godot-backend.exe` |
| Linux x64 | `x86_64-linux` | `backend/zig-out/bin/neo-godot-backend` |

Unsupported platforms fall back to the TypeScript implementation; the extension must not fail to
activate because a binary is missing. Both x64 binaries ship in one VSIX so the same package covers
Windows and Linux. `.vscodeignore` whitelists only
`backend/zig-out/bin/neo-godot-backend` and `backend/zig-out/bin/neo-godot-backend.exe`, and
`tools/verify_vsix.sh` rejects backend sources, build metadata, compiler caches, debug symbols and a
non-executable Linux binary. CI builds both targets before packaging; the release workflow rebuilds
them before it packages the VSIX.

The release VSIX is packaged on Linux. `@vscode/vsce` passes no mode of its own to the zip writer, which
falls back to the file mode on disk. A Windows checkout has no executable bit for a Linux binary, so an
archive packaged there records `0666` and the sidecar cannot start after install. The CI and release
workflows therefore build on Ubuntu, run `chmod +x` on `zig-out/bin/neo-godot-backend`, and verify the
resulting entry with `tools/verify_vsix.sh`. A VSIX built on Windows is a local debugging artifact only.

## Rollback

The sidecar is additive. Removing the spawn, or setting the feature off, returns the extension to the
TypeScript lexer and the TypeScript symbol index with no data migration, because the backend owns no
durable state. The mirror can also be detached on its own: `LanguageService.getWorkspaceSymbolsAsync`
returns the index answer when no mirror is attached, and the workspace symbol provider goes back to
answering synchronously. Each migration step is separately revertible, so a bad parser step can be
reverted without touching the protocol layer or the symbol contract.

## Differential testing

Equivalence is proven against the TypeScript implementation, not against expectations written twice.

`src/backend/zig_backend.test.ts` spawns the real binary and compares `lex` output with `lexGDScript` on:

- ordinary declarations and indented bodies;
- LF, CRLF and mixed line endings, including trailing newlines;
- tabs versus spaces and mixed indentation;
- non-ASCII comments and identifiers outside the ASCII ranges;
- non-BMP characters and lone surrogate pairs in strings and comments;
- escape sequences, unterminated strings and a trailing backslash;
- three-character and two-character operators, plus unknown characters;
- empty input and whitespace-only input.

The comparison is structural: every field of every token must match, so a change in `indent`, `line` or
`character` fails the build. Tests `skip` when the binary is absent so a plain `npm run test:unit` works
on a fresh checkout; CI runs a separate enforced step after building the binary, where a missing binary
is a failure rather than a skip.

`src/backend/zig_backend_parse.test.ts` does the same for `parse`: it compares the whole `ast` and
`diagnostics` object with `parseGDScript` for top-level declarations, nested classes and enums,
annotations, static functions, anonymous enums, an inner class with `extends`, CRLF and mixed line
endings, non-ASCII text and lone surrogates, malformed declarations, function bodies that must not leak
declarations, and empty or whitespace-only input. It also checks that the adapter's `parse` capability
starts false and turns true after the handshake, that four concurrent parse requests keep their
results separate, that `parse` rejects after shutdown, that a 100-level nested class chain matches
`parseGDScript`, and that 300 levels reject with the documented detail while the next request still
succeeds on the same process. The Windows CI job compiles `tsconfig.test.json` and runs both
differential files against the native binary with the backend required.

`src/index/zig_symbol_mirror.test.ts` tests the mirror twice. A stub backend covers the refusal paths:
missing capability, a sidecar that will not start, a digest that does not match the snapshot, a flush
that exceeds the budget, and a non-ASCII name that arrives after the table was built. With the real
binary it also compares the native answer with `symbolIndex.workspaceSymbols` for a name set that covers
punctuation, digits and case, checks duplicate names across files fall back to uri order, follows an
upsert and a removal, rebuilds after `clear`, and runs two mirrors against one process to prove the stale
revision resync works.

Zig unit tests cover the lexer in isolation, the framing layer with in-memory readers, the store
comparator and revision guard, the `symbols/*` handlers and the store-backed server loop. They run
through `src/tests.zig`, which imports every module so the `test` blocks are reachable; testing
`src/main.zig` directly would run zero tests.

## Performance gates

The sidecar only earns its place if it beats the current path without hurting latency.

- Lexing p50 for a 1 MiB script must be at least as fast as the TypeScript lexer on the same machine.
- End-to-end round-trip overhead for a small request must stay under 1 ms p50 locally once the process
  is warm; process startup is measured separately and is amortised by the long-lived process.
- A frame copy budget: source crosses the boundary once as base64 and is decoded once. No additional
  full-text copies per token.
- No unbounded growth: pending requests, per-document snapshots, the mirror's pending maps and its query
  cache are bounded, and cancellation frees a pending entry immediately.
- A workspace query must beat the TypeScript index once the table is synchronized, and must not slow the
  first query of a session beyond the 150 ms budget.

Measured on the development machine (Windows x64, ReleaseSafe build) with a generated workspace of 5,000
files and 30,000 symbols, through the wired provider path with the mirror attached:

| Measurement | TypeScript index | Zig mirror |
| --- | --- | --- |
| `workspaceSymbols("")`, cached | 16.4-16.8 ms p50 | 0.01-0.02 ms p50 |
| `workspaceSymbols("get")`, cached | 2.1-2.2 ms p50 | about 0.01 ms p50 |
| First touch over 40 distinct needles | 2.09 ms p50 / 3.06 ms p95 | 1.51 ms p50 / 2.48 ms p95 |
| Global empty-prefix completion | 22.6-23.6 ms p50 / 25.1-27.1 ms p95 | 5.1-5.8 ms p50 / 6.6-8.3 ms p95 |

Index build for that workspace takes 204-225 ms and the first native sync 158-161 ms, paid once when the
mirror is attached. The first touch of a needle that is not cached costs one IPC round trip, measured at
1.2-1.4 ms locally; repeated queries are served from the 128-entry cache. These numbers describe this
machine and are not a CI gate.

`tools/profile_native_parse.ts` measures `parse` end to end against `parseGDScript` on the same process.
It reports the startup plus first parse separately, then p50 and p95 for each corpus after a warmup,
using 40 samples and 10 warmup iterations by default. Run it with `npx ts-node
tools/profile_native_parse.ts` after `npm run build:backend`, and override the counts with
`PROFILE_ITERATIONS` and `PROFILE_WARMUP`. It first asserts that the native result deep-equals the
TypeScript result for every corpus entry, so a benchmark run cannot hide a fidelity regression.

Measured on the development machine (Windows x64, Node v26.13.0, ReleaseSafe build):

| Corpus | UTF-16 units | TypeScript p50 / p95 | Native p50 / p95 | Native p50 vs TypeScript |
| --- | ---: | --- | --- | ---: |
| typical-script | 379 | 0.0382 / 0.0572 ms | 0.1196 / 0.1893 ms | 0.32x |
| generated-64 | 8,570 | 0.2523 / 0.3077 ms | 1.1021 / 1.3968 ms | 0.23x |
| generated-512 | 70,250 | 1.6825 / 3.1419 ms | 7.5177 / 8.7958 ms | 0.22x |
| generated-2048 | 286,410 | 14.9198 / 21.3709 ms | 28.88 / 36.4668 ms | 0.52x |

Startup plus the first parse took 58.1 ms, which the long-lived process pays once. The steady-state
result is the important one: the native path is 1.9x to 4.5x slower end to end than the TypeScript
parser. The parse itself is not the bottleneck; base64 encoding, the framed round trip, JSON
serialisation of the AST and decoding it back into a JavaScript object dominate. The native parser
therefore does not meet the performance gate, and no default analysis path calls it. It earns its
place only as opt-in groundwork until the protocol carries a compact AST, or a caller can amortise
the round trip over work that stays in the sidecar.

The gate for wiring this path into a provider is explicit: native `parse` must reach the same p50 as
`parseGDScript` for every corpus entry, measured by `tools/profile_native_parse.ts` on the same host
and process. Until that holds, the adapter stays opt-in and the TypeScript parser remains the only
analysis path.

These measurements come from Node 26 on one host and are not a CI gate; CI runs Node 22.x and only
checks that the differential suite passes. The direction of the result is not sensitive to that
difference, because the cost is on the wire rather than in the parser.

## Migration order

Each step lands only after the previous one is differentially verified and can be reverted on its own.

```text
1. protocol and process management   <- shipped
2. lexer                            <- shipped
3. workspace symbol mirror          <- shipped
4. parser and AST                   <- shipped as opt-in
5. native semantic index and queries
6. remaining provider integration
7. formatter
8. scene and resource parsing
9. debug protocol
10. Godot LSP bridge
```

The symbol mirror went first because it needs no parser: the TypeScript index already owns the symbol
objects, so the native side only has to reproduce the ordering contract for names it receives. The
parser stage is shipped as an adapter capability, not wired into a provider: the measured round trip
is slower than calling `parseGDScript` locally, and the semantic index has to live in the sidecar
before moving a provider would pay off. The remaining provider integration still waits for the native
semantic index, because a partial native model would answer questions the TypeScript implementation
currently answers correctly.

## Repository layout

```text
backend/
  build.zig          native build graph and test step
  build.zig.zon      package metadata, minimum Zig version
  src/main.zig       entry point, stdio wiring
  src/protocol.zig   framing and JSON-RPC message handling
  src/server.zig     request dispatch for health, lex, parse, symbols, shutdown
  src/lexer.zig      UTF-16 GDScript tokenizer
  src/parser.zig     declaration parser matching src/analyzer/parser.ts
  src/symbol_index.zig workspace symbol store and ASCII collation
  src/tests.zig      test root that imports every module for `zig build test`
src/backend/
  zig_backend.ts     spawn, framing, request/response adapter
  zig_backend.test.ts differential tests against lexGDScript
  zig_backend_parse.test.ts differential tests against parseGDScript
src/index/
  ascii_collation.ts host collation probe and the shared ASCII comparator
  zig_symbol_mirror.ts native symbol mirror and its fallback rules
  zig_symbol_mirror.test.ts differential tests against symbol_index
tools/
  profile_native_parse.ts end-to-end parse benchmark against parseGDScript
```

## Verification of this document

Every statement about Zig APIs above was checked against the 0.17.0 standard library sources shipped
with the pinned toolchain (`std.process.Init`, `std.Io.Reader`/`Writer` streaming APIs, `std.json`,
`std.base64`). If a later Zig release renames these, the version pin is what keeps the document true;
upgrading is a deliberate change with a new hash and a re-run of the differential suite.
