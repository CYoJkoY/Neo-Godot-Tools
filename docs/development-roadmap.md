# Development Roadmap

Neo-Godot-Tools is a VS Code language and debugging toolchain for Godot. The current strategic priority is to make GDScript language intelligence **local-first, incremental, measurable, and reliable**, while retaining Godot's native LSP as a semantic fallback for cases the local analyzer cannot model safely.

## 1. Current direction

The project already has a local GDScript parser/analyzer, symbol/binding/reference indexes, dependency-aware invalidation, update coalescing, profiling instrumentation, and a Godot LSP fallback path.

The target architecture is:

```text
VS Code Providers
        │
        ▼
  LanguageService
        │
        ▼
 Semantic Query Engine
        │
   ┌────┴─────┐
   ▼          ▼
Incremental  Dependency
Semantic DB    Graph
   │
   ▼
Analyzer / Parser
        │
        ▼
Godot LSP fallback
```

The objective is not to replace Godot LSP for ideological reasons. It is to make Godot LSP unnecessary for the common project-level case while preserving it for hard semantic cases.

## 2. Development principles

### Local first

Common project-level language operations should be answered locally whenever the result is sufficiently certain.

### Godot LSP as semantic oracle

Use Godot LSP for engine-native semantics, dynamic or ambiguous cases, unsupported constructs, and situations where the local model cannot provide a trustworthy answer.

### Incremental by default

A changed document must not trigger unnecessary workspace-wide parsing or semantic recomputation.

### Measure before optimizing

Do not add worker threads, persistent caches, or complex concurrency merely because they appear theoretically faster. Major performance changes require reproducible measurements.

### Correctness before coverage

A wrong local completion or definition is worse than a slower fallback. The local analyzer must fall back when confidence is insufficient.

### Stable boundaries

Keep parser, analyzer, semantic indexes, query engine, provider adapters, and Godot LSP transport separated. VS Code APIs should not leak into the core semantic model.

## 3. Phase A — LSP audit and observability

**Status: next**

Establish exactly how the current language path behaves before another large refactor.

Tasks:

- enumerate every Godot LSP request and notification;
- identify providers that still use Godot LSP for normal project symbols;
- identify repeated parsing and indexing;
- identify synchronous filesystem or CPU work on the extension host;
- verify cancellation and stale-response behavior;
- measure cold-start and incremental-update latency;
- count Godot LSP requests per editor action.

Required metrics:

| Metric | Purpose |
| --- | --- |
| p50 / p95 / p99 latency | User-visible responsiveness |
| parser time | Parsing bottleneck detection |
| symbol collection time | AST-to-index cost |
| index update time | Incremental update cost |
| semantic recomputation time | Invalidation efficiency |
| Godot LSP requests/action | Local-first effectiveness |
| memory usage | Large-project scalability |
| initial indexing time | Startup cost |

## 4. Phase B — Semantic query engine

**Status: planned**

Create a small semantic query boundary so providers no longer implement independent lookup logic.

Core operations should converge toward:

```text
getSymbol(uri, position)
getDefinition(symbol)
getType(expression)
getMembers(type)
getReferences(symbol)
getHover(symbol)
getCompletion(context)
```

Requirements:

- deterministic results;
- document-version aware queries;
- selective cache invalidation;
- deduplication of identical work;
- explicit unknown/unsupported results;
- a clean Godot LSP fallback boundary.

## 5. Phase C — Confidence-aware semantic resolution

**Status: planned**

Use an explicit confidence model:

```text
exact
inferred
partial
unknown
```

Routing:

```text
local result
    │
    ├── exact / safe inferred ──> return locally
    │
    └── partial / unknown ──────> Godot LSP fallback
```

This prevents aggressive local inference from silently producing incorrect editor behavior.

## 6. Phase D — Provider migration

**Status: planned**

Migrate providers one capability at a time.

Priority:

1. definition;
2. hover;
3. completion;
4. references;
5. document symbols;
6. workspace symbols;
7. rename;
8. signature help and other semantic features.

Engineering targets for ordinary project code:

| Capability | Local target |
| --- | ---: |
| Definition | ≥98% |
| Hover | ≥95% |
| Completion | ≥95% |
| References | ≥95% |

These are targets, not correctness guarantees. Unsafe cases must fall back.

## 7. Phase E — Incremental semantic database

**Status: planned**

Strengthen the current file/index model into an incremental semantic database.

Each indexed file should have a stable semantic snapshot containing:

- symbols;
- bindings;
- references;
- declarations;
- inheritance;
- signals;
- constants;
- exported members;
- script dependencies;
- semantic/API fingerprint.

A function-body-only edit should not invalidate dependents when the public/API fingerprint is unchanged.

## 8. Phase F — Dependency-aware invalidation

**Status: planned**

Distinguish at least:

```text
body change
API change
inheritance change
dependency addition/removal
file deletion
```

For example:

```text
Function body changed
        ↓
local file re-indexed
        ↓
API fingerprint unchanged
        ↓
no dependent semantic invalidation
```

An API or inheritance change should invalidate only affected dependents.

## 9. Phase G — Completion and interactive latency

**Status: planned**

Completion is the most latency-sensitive provider because it runs during typing.

Requirements:

- no full-file parsing per keystroke when unnecessary;
- reuse the current document snapshot;
- cache by document version and semantic context;
- cancel obsolete requests;
- avoid routine completion requests to Godot LSP;
- keep extension-host work within an interactive latency budget.

Benchmarks must include rapid typing, not only isolated requests.

## 10. Phase H — LSP transport hardening

**Status: planned**

After local-first routing is established, make the remaining Godot LSP path predictable.

Requirements:

- one well-defined connection lifecycle;
- explicit initialization state;
- request cancellation where supported;
- stale-response rejection;
- bounded failure behavior;
- no duplicate clients for the same workspace;
- clear distinction between transport failure and semantic unknown;
- instrumentation for every fallback request.

Do not hide LSP failures by suppressing errors. Fix the routing and lifecycle that cause them.

## 11. Phase I — Large-project scalability

**Status: planned**

Benchmark at least:

```text
100 files
500 files
1,000 files
5,000 files
```

Test startup, document open, rapid typing, save, external changes, completion, hover, definition, references, rename, and dependency changes.

Record p50/p95/p99 latency and memory usage for each workload.

Only after measurement should persistent disk caching or worker-thread parsing be considered.

## 12. Phase J — Worker-thread evaluation

**Status: conditional**

`worker_threads` is not a default requirement.

Introduce workers only if profiling proves parser/index CPU is the dominant source of extension-host latency after scheduling, caching, and invalidation have been optimized.

If I/O, semantic invalidation, or Godot LSP fallback dominates, workers are not the correct solution.

## 13. Phase K — Godot compatibility matrix

**Status: planned**

Maintain explicit verification across supported Godot generations, especially Godot 3.x and 4.x.

The local parser/analyzer must not accidentally assume a Godot 4-only syntax model when compatibility with Godot 3.x is expected.

Engine-in-the-loop tests should cover representative versions in CI.

## 14. Phase L — Release quality

**Status: ongoing**

Release engineering follows clean SemVer:

```text
package.json: 2.8.0
stable tag:   v2.8.0
dev tag:      v2.8.0.dev1
```

The source version remains clean; development numbering belongs to the Git tag and release metadata.

Every release should pass lint, compile, unit tests, relevant engine tests, package validation, and release-version validation.

## 15. Explicitly out of scope for now

Do not implement these merely for theoretical completeness:

- a complete replacement for Godot's native semantic engine;
- a full GDScript compiler;
- whole-program control-flow analysis;
- generic/union type machinery before real use cases require it;
- persistent semantic caches before startup profiling justifies them;
- worker threads before CPU profiling justifies them;
- a second language server implementation solely for architectural purity.

The objective is a fast, correct, maintainable language service for real Godot projects.

## 16. Definition of architectural success

Normal project editing should follow:

```text
Editor event
    ↓
Incremental document snapshot
    ↓
Local parser/analyzer
    ↓
Incremental semantic indexes
    ↓
Semantic query engine
    ↓
Local provider result
```

Godot LSP should primarily handle:

```text
engine-native semantics
        OR
unsupported constructs
        OR
ambiguous/dynamic semantics
        OR
local model unavailable
```

The long-term metric is therefore not "replace Godot LSP". It is:

> **Make Godot LSP unnecessary for the common case while preserving it as the authoritative fallback for hard cases.**
