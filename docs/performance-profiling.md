# Language Performance Profiling

The local GDScript language path now has two levels of profiling.

## Runtime instrumentation

`src/performance/profiler.ts` provides a low-overhead in-memory profiler. The language index records:

- `parse`: GDScript lexing and parsing time
- `collectSymbols`: AST symbol extraction time
- `scheduledUpdate`: time spent applying a scheduled update

Metrics expose sample count, accumulated time, and maximum observed time. The profiler does not write files or emit logs on every edit, so normal editing remains quiet.

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

Use p95 rather than only the average when deciding whether parsing is responsible for editor latency. If parser and symbol collection remain small while scheduled updates are expensive, inspect downstream indexes and invalidation. If parsing dominates at realistic project sizes, worker-thread offloading becomes a candidate for a later phase.
