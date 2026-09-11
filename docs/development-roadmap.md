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
- runtime profiling for parser, indexing, scheduled updates, semantic queries, and LSP requests;
- a real-project semantic benchmark runner and versioned Godot 3/4 compatibility fixtures.

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
| A — LSP audit & observability | **Implemented foundation** | Provider/LSP profiling exists; empirical fallback measurements remain. |
| B — Semantic Query Engine | **Implemented** | Core query boundary, local resolution, and query-local caching are in place. |
| C — Confidence-aware resolution | **Implemented foundation** | Exact/inferred/partial/unknown exist with centralized routing; semantic coverage continues to expand. |
| D — Provider migration | **Mostly implemented** | Definition, hover, completion, references, rename, signature help, document symbols, and workspace symbols use local paths; fallback edge cases remain. |
| E — Incremental semantic DB | **Substantially implemented** | Stable snapshots, API fingerprints, semantic indexes, and targeted invalidation are present. |
| F — Dependency-aware invalidation | **Implemented foundation** | Semantic classification, transitive invalidation, and unresolved dependency refresh are present. |
| G — Completion & interactive latency | **Implemented foundation** | Local completion, dependency-aware caching, cancellation checks, profiling, stale-result protection, and a rapid-typing benchmark exist; real budgets remain to be measured. |
| H — LSP transport hardening | **Implemented foundation** | Lifecycle generation guards, cancellation boundaries, stale-response rejection, request instrumentation, and stale-client event rejection exist; failure-path validation remains. |
| I — Large-project scalability | **Benchmark infrastructure implemented** | Synthetic and real-project benchmark runners exist; representative real-project measurements remain required. |
| J — Worker-thread evaluation | **Conditional / deferred** | Implement only if profiling proves parser/index work is CPU-bound. |
| K — Godot compatibility matrix | **Fixture foundation implemented** | CI exercises Godot 4.5.1 and 4.7; representative Godot 3/4 semantic fixtures are now formalized. Expand from observed compatibility failures. |
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

The repository now contains both synthetic and real-project semantic benchmarks.

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

`tools/semantic_project_benchmark.ts` now measures cold indexing, incremental edits, rapid-typing updates, and warm local semantic type/definition/hover/completion queries directly against a real Godot project.

The remaining evidence gate is empirical: run it against representative real projects and compare p95/p99 against the budgets below. Only after those measurements should persistent disk caching or worker threads be considered.

## 7. LSP hardening

Fallback must be predictable rather than dominant.

Required properties:

- one connection lifecycle per workspace context;
- explicit initialization state;
- request cancellation where supported;
- stale-response rejection;
- stale-client event rejection after reconnect/replacement;
- bounded failure behavior;
- clear distinction between transport failure and semantic unknown;
- instrumentation for every fallback request.

LSP failures must not be hidden by suppressing errors. Routing and lifecycle should be corrected instead.

## 8. Godot compatibility

CI currently exercises Godot 4.5.1 and 4.7. The semantic analyzer should remain syntax/model compatible with the Godot generations the extension claims to support.

Representative versioned fixtures now cover Godot 3-style `export`, `onready`, `yield`, inferred declarations, and Godot 4-style annotations, `@export`, `@onready`, typed returns, `await`, and inferred declarations. The fixture suite is intentionally small and should grow from real compatibility failures.

## 9. Next development gate

The architecture-heavy portion of the roadmap is now complete enough to switch to evidence-driven optimization. The next batch is validation and targeted correction:

1. run `tools/semantic_project_benchmark.ts` against representative real Godot projects;
2. collect p50/p95/p99 latency, extension-host CPU/memory, and LSP fallback frequency during real editing;
3. add provider-level routing counters if profiler data cannot answer a specific question;
4. add a fixture whenever a real Godot 3.x/4.x project exposes a syntax or semantic regression;
5. improve expression/range parsing only for measured local-coverage gaps;
6. harden LSP failure/cancellation behavior from measured failure cases;
7. re-evaluate persistent disk caching and worker threads only if the measurements justify them.

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
