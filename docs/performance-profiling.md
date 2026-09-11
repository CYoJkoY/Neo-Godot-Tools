# Language Performance Profiling

The local GDScript language path has two levels of profiling.

## Runtime instrumentation

`src/performance/profiler.ts` provides a low-overhead in-memory profiler. The language index records:

- `parse`: GDScript lexing and parsing time
- `collectSymbols`: AST symbol extraction time
- `scheduledUpdate`: time spent applying a scheduled update
- `lsp.request.<method>`: round-trip latency for every Godot LSP request that is actually sent

Each metric exposes sample count, accumulated time, maximum observed time, and recent p50/p95/p99 latency. Only the most recent 512 latency samples per metric are retained, so long-running editor sessions do not accumulate an unbounded timing history.

LSP requests are measured at the transport boundary rather than only inside individual fallback providers. This captures requests initiated by the existing extension surface and makes the remaining LSP dependency visible without changing routing behavior.

The profiler does not write files or emit logs on every edit, so normal editing remains quiet.

## Reproducible benchmark

Run the analyzer benchmark with the repository's existing `ts-node` dependency:

```text
ts-node tools/profile_language.ts
```

The benchmark warms the parser, processes a synthetic multi-file GDScript corpus, and reports p50, p95, max latency and files/second as JSON.

The workload can be scaled without changing source code:

```text
PROFILE_FILES=1000 PROFILE_ITERATIONS=10 ts-node tools/profile_language.ts
```

On Windows PowerShell:

```text
$env:PROFILE_FILES = "1000"
$env:PROFILE_ITERATIONS = "10"
ts-node tools/profile_language.ts
```

## Interpretation

Use p95 rather than only the average when deciding whether parsing is responsible for editor latency. Compare local parser/index timings with `lsp.request.<method>` timings before choosing the next optimization.

The Phase A baseline should answer three questions:

1. Which Godot LSP methods are still requested during normal GDScript editing?
2. How expensive are those requests at p50/p95/p99?
3. Is local parsing/indexing or LSP fallback the dominant source of interactive latency?

If parser and symbol collection remain small while scheduled updates are expensive, inspect downstream indexes and invalidation. If parsing dominates at realistic project sizes, worker-thread offloading becomes a candidate for a later phase. If LSP requests dominate, migrate the affected provider to the local semantic path before adding concurrency.
