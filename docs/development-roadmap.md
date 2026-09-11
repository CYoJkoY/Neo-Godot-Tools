# Development Roadmap

Neo-Godot-Tools is a VS Code language and debugging toolchain for Godot. The strategic priority is to make GDScript language intelligence **local-first, incremental, measurable, and reliable**, while retaining Godot's native LSP as a semantic fallback for cases the local analyzer cannot model safely.

## 1. Current architecture

The local semantic path now contains:

- GDScript parser and lexer-backed AST/range model;
- `FileIndex` with source/API snapshots;
- `SymbolIndex`, `BindingIndex`, and `ReferenceIndex`;
- `TypeResolutionIndex` for local type/member resolution;
- range-aware local assignment and simple branch propagation;
- dependency topology tracking with unresolved-target refresh;
- semantic change classification and targeted invalidation;
- `SemanticQueryEngine` as the semantic query boundary;
- query-result caching with source/API and external query-dependency snapshots;
- update coalescing and stale filesystem-update protection;
- Godot LSP as the fallback/engine-semantic boundary;
- runtime profiling for parser, indexing, scheduled updates, semantic queries, and LSP requests.

Target flow:

```text
VS Code Providers
        │
        ▼
  LanguageService
        │
        ▼
 Semantic Query Engine
        │
   ┌────┴──────────┐
   ▼               ▼
Incremental     Dependency
Semantic DB       Graph
   │               │
   └──────┬────────┘
          ▼
   Parser / Analyzer
          │
          ▼
 Godot LSP fallback
```

The objective is not to replace Godot LSP for ideological reasons. It is to make Godot LSP unnecessary for common project-level semantics while preserving it for engine-native, dynamic, ambiguous, or unsupported cases.

## 2. Implementation status

| Phase | Status | Notes |
| --- | --- | --- |
| A — LSP audit & observability | **Mostly complete** | Routing audit and runtime instrumentation exist; real project measurements remain. |
| B — Semantic Query Engine | **Implemented** | Core query boundary, local resolution, and query-local caching are in place. |
| C — Confidence-aware resolution | **Implemented foundation** | Exact/inferred/partial/unknown exist with centralized definition/hover routing; semantic coverage continues to expand. |
| D — Provider migration | **Mostly implemented** | Definition, hover, completion, references, rename, signature help, document symbols, and workspace symbols use local paths; fallback edge cases remain. |
| E — Incremental semantic DB | **Substantially implemented** | Stable snapshots, API fingerprints, semantic indexes, and targeted invalidation are present. |
| F — Dependency-aware invalidation | **Implemented foundation** | Semantic classification, transitive invalidation, and unresolved dependency refresh are present. |
| G — Completion & interactive latency | **Implemented foundation** | Local completion, dependency-aware caching, cancellation checks, profiling, and stale-result protection exist; real rapid-typing budgets remain to be measured. |
| H — LSP transport hardening | **Substantially implemented** | Lifecycle generation guards, cancellation boundaries, stale-response rejection, and request instrumentation exist; failure-path validation remains. |
| I — Large-project scalability | **Benchmark infrastructure implemented** | Synthetic 100/500/1K/5K workloads exist; real project measurements remain required. |
| J — Worker-thread evaluation | **Conditional / deferred** | Implement only if profiling proves parser/index work is CPU-bound. |
| K — Godot compatibility matrix | **Partial** | CI exercises Godot 4.5.1 and 4.7; explicit Godot 3.x semantic coverage still needs to be formalized where support is required. |
| L — Release quality | **Ongoing** | CI, packaging, version validation, and release workflow continue to evolve. |

## 3. Local type inference coverage

The local resolver currently covers:

- explicit and inferred local declarations;
- literal types;
- constructor calls such as `Vector2(...)` and `Type.new(...)`;
- `preload("...").new()` script construction;
- conservative `load(...)` resource inference;
- conditional expressions when both branches resolve to the same type;
- assignment-based propagation within a function;
- simple `if` / `elif` / `else` branch propagation;
- local function return inference;
- local/member call return propagation;
- declared member-type propagation;
- inheritance-aware project member resolution.

The intended rule remains:

```text
certain local type
      ↓
local semantic result

ambiguous / unsupported / dynamic
      ↓
Godot LSP fallback
```

The resolver deliberately does not attempt to become a full GDScript compiler.

## 4. Confidence-aware routing

Routing is explicit and conservative:

```text
exact
  → return locally

safe inferred
  → return locally

partial / ambiguous
  → fallback

unknown / unsupported
  → Godot LSP
```

The important property is not maximum local coverage. It is avoiding confidently wrong editor results.

## 5. Provider state

| Capability | Local path | Remaining focus |
| --- | --- | --- |
| Definition | Semantic Query Engine | confidence/routing edge cases |
| Hover | Semantic Query Engine | inferred-type coverage |
| Completion | Semantic Query Engine | rapid-typing latency and context precision |
| References | Semantic Query Engine / BindingIndex | dynamic/unsupported cases |
| Rename | BindingIndex | cross-file semantic edge cases |
| Signature Help | local binding/symbol resolution | richer call parsing and fallback |
| Document Symbols | FileIndex | richer symbol coverage |
| Workspace Symbols | SymbolIndex | indexing scale |

## 6. Performance and scalability

The repository now contains both real-project and synthetic semantic benchmarks.

Required workloads:

```text
100 files
500 files
1,000 files
5,000 files
```

Measure at least:

- cold startup/indexing;
- document open;
- single edit;
- rapid typing;
- save/external change;
- completion;
- hover;
- definition;
- references;
- rename;
- signature help;
- dependency/API change;
- p50/p95/p99 latency;
- extension-host CPU and memory;
- Godot LSP requests per editor action.

Current synthetic scale benchmarks measure cold indexing, incremental edits, and warm semantic type/definition/hover/completion queries. Real project measurements are the next evidence gate.

Only after those measurements should persistent disk caching or worker threads be considered.

## 7. LSP hardening

Fallback must be predictable rather than dominant.

Required properties:

- one connection lifecycle per workspace context;
- explicit initialization state;
- request cancellation where supported;
- stale-response rejection;
- bounded failure behavior;
- clear distinction between transport failure and semantic unknown;
- instrumentation for every fallback request.

LSP failures must not be hidden by suppressing errors. Routing and lifecycle should be corrected instead.

## 8. Godot compatibility

CI currently exercises Godot 4.5.1 and 4.7. The semantic analyzer should remain syntax/model compatible with the Godot generations the extension claims to support.

The next compatibility step is a small versioned fixture suite covering representative Godot 3.x and 4.x syntax and semantic cases, without coupling the local analyzer to a single engine generation.

## 9. Next development gate

The next large engineering batch should combine the evidence and compatibility work rather than adding speculative infrastructure:

1. run the benchmark suite against real Godot projects;
2. expose provider-boundary and fallback-frequency measurements;
3. add rapid-typing interactive benchmarks;
4. formalize Godot 3.x/4.x semantic fixtures where support is required;
5. improve expression/range parsing only where real projects demonstrate missing local coverage;
6. harden LSP failure and cancellation behavior from measured failure cases.

Persistent disk semantic caches and worker threads remain conditional on those measurements.

## 10. Explicitly out of scope for now

Do not implement these merely for theoretical completeness:

- a complete replacement for Godot's native semantic engine;
- a full GDScript compiler;
- whole-program control-flow analysis;
- generic/union type machinery before real use cases require it;
- persistent semantic caches before startup profiling justifies them;
- worker threads before CPU profiling justifies them;
- a second language server implementation solely for architectural purity.

## 11. Definition of architectural success

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

> **Long-term metric:** Make Godot LSP unnecessary for the common case while preserving it as the authoritative fallback for hard cases.
