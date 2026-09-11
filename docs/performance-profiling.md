# Language Performance Profiling

Neo-Godot-Tools has runtime instrumentation for the local GDScript path and for Godot LSP fallback requests. The project is now at the point where measurements should drive the next optimization stage rather than adding more cache layers speculatively.

## Runtime instrumentation

`src/performance/profiler.ts` provides a low-overhead in-memory profiler. The language/index path records:

- `parse`: GDScript parsing time;
- `collectSymbols`: AST-to-symbol extraction time;
- `scheduledUpdate`: time spent applying a scheduled update;
- `lsp.request.<method>`: round-trip latency for every Godot LSP request that is actually sent.

Each metric exposes sample count, accumulated time, maximum observed time, and recent p50/p95/p99 latency. Only the most recent 512 latency samples per metric are retained so long-running editor sessions do not accumulate an unbounded timing history.

LSP requests are measured at the transport boundary rather than only inside fallback providers. This makes the remaining LSP dependency visible without changing routing behavior.

The profiler does not write files or emit logs on every edit, so normal editing remains quiet.

## Current optimization model

The project has already implemented several optimizations that should be treated as architectural foundations rather than benchmark hypotheses:

```text
Editor events
    ↓
UpdateScheduler
    ↓
Incremental FileIndex
    ↓
Semantic change classification
    ↓
Targeted index / dependency invalidation
    ↓
Query dependency snapshots
    ↓
Semantic cache reuse
```

The cache layer tracks the external semantic state a query depends on. Further cache layers should not be added until measurements show a remaining cacheable bottleneck.

## Reproducible parser benchmark

Run the analyzer benchmark with the repository's existing `ts-node` dependency:

```text
ts-node tools/profile_language.ts
```

The benchmark warms the parser, processes a synthetic multi-file GDScript corpus, and reports p50, p95, max latency, and files/second as JSON.

Scale the workload without changing source code:

```text
PROFILE_FILES=1000 PROFILE_ITERATIONS=10 ts-node tools/profile_language.ts
```

On Windows PowerShell:

```text
$env:PROFILE_FILES = "1000"
$env:PROFILE_ITERATIONS = "10"
ts-node tools/profile_language.ts
```

## Required project-scale benchmark

The formal scalability phase should cover:

```text
100 files
500 files
1,000 files
5,000 files
```

For each size, measure:

- cold startup and initial indexing;
- document open;
- one-character edit;
- rapid typing burst;
- save and external file change;
- completion;
- hover;
- definition;
- references;
- rename;
- dependency/API change;
- memory usage;
- extension-host CPU usage;
- Godot LSP requests per editor action.

Record p50/p95/p99 rather than relying on averages alone.

## Interpreting results

Use the following decision tree:

```text
High LSP latency / request count
        ↓
inspect local semantic coverage and fallback routing

High parser CPU
        ↓
inspect parser/index workload
        ↓
consider workers only after other incremental work is validated

High scheduled-update cost
        ↓
inspect secondary indexes and invalidation scope

High memory
        ↓
inspect retained indexes/caches before adding persistence
```

Worker threads are not a default optimization. They are justified only if profiling proves parser/index CPU is the dominant source of interactive latency after scheduling, caching, and invalidation are already effective.

## Priority metrics

| Metric | Why it matters |
| --- | --- |
| p50 latency | typical interaction |
| p95 latency | common tail latency |
| p99 latency | worst interactive tail |
| parser time | syntax processing bottleneck |
| symbol collection | index construction cost |
| scheduled update | event-to-index latency |
| semantic recomputation | invalidation efficiency |
| LSP requests/action | local-first effectiveness |
| memory | project-scale viability |
| initial indexing | startup experience |

The strategic metric is not simply "parser milliseconds". It is whether normal project editing can stay local and interactive without repeatedly invoking Godot LSP.
