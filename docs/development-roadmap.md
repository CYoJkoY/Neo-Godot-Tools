# Development Roadmap

Neo-Godot-Tools is a VS Code language and debugging toolchain for Godot. The current strategic priority is to make GDScript language intelligence **local-first, incremental, measurable, and reliable**, while retaining Godot's native LSP as a semantic fallback for cases the local analyzer cannot model safely.

> **Status note:** This roadmap describes the implementation state of `master` after the Semantic Query Engine, provider migrations, incremental invalidation, and query-dependency cache work. The type-inference expansion currently under development is intentionally listed as **next**, not as completed work.

## 1. Current architecture

The project has moved beyond the original LSP-audit stage. The current local path contains:

- GDScript parser and AST model;
- `FileIndex` with source/API snapshots;
- `SymbolIndex`, `BindingIndex`, and `ReferenceIndex`;
- `TypeResolutionIndex` for local type/member resolution;
- dependency topology tracking with unresolved-target refresh;
- semantic change classification and targeted invalidation;
- `SemanticQueryEngine` as the semantic query boundary;
- query-result caching with source/API and external query-dependency snapshots;
- update coalescing and stale filesystem-update protection;
- Godot LSP as the fallback/engine-semantic boundary;
- runtime profiling for parser, indexing, scheduled updates, and LSP requests.

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
| A — LSP audit & observability | **Mostly complete** | Routing audit and runtime instrumentation exist; reproducible project-scale measurements remain. |
| B — Semantic Query Engine | **Implemented** | Core query boundary and local caching are in place. |
| C — Confidence-aware resolution | **Partially implemented** | `exact` / `inferred` / `partial` / `unknown` exist, but routing policy and semantic coverage still need refinement. |
| D — Provider migration | **Mostly implemented** | Definition, hover, completion, references, rename, signature help, document symbols, and workspace symbols use local paths; edge-case fallback behavior remains to be hardened. |
| E — Incremental semantic DB | **Substantially implemented** | Stable snapshots, API fingerprints, semantic indexes, and targeted invalidation are present; semantic coverage is still expanding. |
| F — Dependency-aware invalidation | **Implemented foundation** | Semantic change classification, transitive invalidation, and incremental dependency topology refresh are present. |
| G — Completion & interactive latency | **Partially implemented** | Local completion and dependency-aware caching exist; cancellation, rapid-typing benchmarks, and latency budgets remain. |
| H — LSP transport hardening | **Partially implemented** | Transport boundary and request instrumentation exist; lifecycle, cancellation, stale-response, and failure semantics need further work. |
| I — Large-project scalability | **Not started as a formal benchmark phase** | The architecture is incremental, but 100/500/1K/5K-file measurements are still required. |
| J — Worker-thread evaluation | **Conditional / deferred** | Do not implement until profiling proves CPU-bound parser/index work is the bottleneck. |
| K — Godot compatibility matrix | **Partial** | Existing engine validation exists, but explicit Godot 3.x/4.x semantic coverage needs to be formalized. |
| L — Release quality | **Ongoing** | CI, packaging, version validation, and release workflow continue to evolve. |

## 3. Completed architectural foundations

### Semantic Query Engine

Providers no longer need to duplicate semantic lookup logic. `SemanticQueryEngine` centralizes local resolution and exposes reusable operations for symbols, definitions, references, hover, and completion.

```text
Provider
   ↓
LanguageService
   ↓
SemanticQueryEngine
   ├── SymbolIndex
   ├── BindingIndex
   ├── ReferenceIndex
   └── TypeResolutionIndex
```

### API-aware invalidation

Indexed files carry an API fingerprint derived from public symbol signatures and inheritance. Function-body-only edits therefore do not automatically invalidate transitive dependents.

```text
body edit
   ↓
API fingerprint unchanged
   ↓
current-file semantic state only
```

An API/inheritance change propagates through the dependency graph to affected dependents.

### Semantic change classification

Updates are classified as:

```text
unchanged
body_changed
api_changed
dependency_changed
file_added
file_removed
```

This classification determines which secondary indexes and semantic caches actually need work.

### Incremental dependency topology

The dependency graph tracks both resolved edges and unresolved candidates. Adding a previously missing target refreshes only candidate dependents instead of rebuilding the workspace graph.

### Query dependency snapshots

Semantic cache entries now record the workspace state they actually depend on:

```text
current file snapshot
        +
symbol lookup signatures
        +
workspace completion signatures
        +
resolved receiver file snapshots
```

A cache entry is reused only while all recorded dependencies remain valid. This closes the correctness gap where an unchanged document could otherwise retain a stale result after another file changed the relevant workspace symbol set.

## 4. Next implementation stage — Type inference expansion

The next semantic milestone is to increase the useful coverage of `TypeResolutionIndex` without turning it into a full GDScript compiler.

Priority areas:

1. typed and untyped variable initializers;
2. assignment-based type propagation;
3. function return inference from `return` expressions;
4. propagation through local function calls;
5. `preload()` / script construction and `load()` handling;
6. member return-type propagation;
7. inheritance-aware member resolution;
8. built-in Godot value types;
9. AST/range-aware resolution instead of broad source regexes where correctness requires it.

The intended rule is conservative:

```text
certain local type
      ↓
local semantic result

ambiguous / unsupported / dynamic
      ↓
Godot LSP fallback
```

Generic/union types, full control-flow analysis, and compiler-equivalent type inference remain out of scope until concrete use cases justify them.

## 5. Confidence-aware routing

The current semantic model already exposes confidence levels, but the routing policy should become explicit and consistent across providers:

```text
exact
  → return locally

safe inferred
  → return locally

partial / ambiguous
  → prefer fallback

unknown / unsupported
  → Godot LSP
```

The important property is not maximum local coverage. It is avoiding confidently wrong editor results.

## 6. Provider completion state

The local-first provider migration is now substantially beyond the original audit. The current target matrix is:

| Capability | Local path | Remaining focus |
| --- | --- | --- |
| Definition | Semantic Query Engine | confidence/routing edge cases |
| Hover | Semantic Query Engine | inferred-type coverage |
| Completion | Semantic Query Engine | latency, cancellation, context precision |
| References | Semantic Query Engine / BindingIndex | dynamic/unsupported cases |
| Rename | BindingIndex | cross-file semantic edge cases |
| Signature Help | local binding/symbol resolution | richer call parsing and fallback |
| Document Symbols | FileIndex | richer symbol coverage |
| Workspace Symbols | SymbolIndex | indexing scale |

## 7. Performance and scalability

The project already measures parser, symbol collection, scheduled updates, and Godot LSP request latency. The next step is evidence rather than another cache layer.

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
- dependency/API change;
- p50/p95/p99 latency;
- extension-host CPU and memory;
- Godot LSP requests per editor action.

Only after these measurements should persistent disk caching or worker threads be considered.

## 8. LSP hardening

The remaining LSP work is about making fallback predictable rather than increasing its usage.

Required properties:

- one connection lifecycle per workspace context;
- explicit initialization state;
- request cancellation where supported;
- stale-response rejection;
- bounded failure behavior;
- clear distinction between transport failure and semantic unknown;
- instrumentation for every fallback request.

LSP failures must not be hidden by suppressing errors. The routing and lifecycle should be corrected instead.

## 9. Godot compatibility

Maintain explicit semantic verification across supported Godot generations, especially Godot 3.x and 4.x. The analyzer must not accidentally encode a Godot 4-only syntax or type model where Godot 3.x support is expected.

Engine-in-the-loop tests should cover representative versions in CI.

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
