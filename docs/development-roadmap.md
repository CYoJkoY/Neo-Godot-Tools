# Development Roadmap

Neo-Godot-Tools is a VS Code language and debugging toolchain for Godot. The strategic priority is **local-first, incremental, measurable, and reliable GDScript intelligence**, while retaining Godot's native LSP as an explicit semantic fallback.

## 1. Current architecture

The local semantic path contains:

- lexer/parser-backed GDScript syntax and range information;
- `FileIndex` with source and API snapshots;
- `SymbolIndex`, `BindingIndex`, and `ReferenceIndex`;
- `TypeResolutionIndex` for local type/member resolution;
- assignment and simple branch propagation;
- dependency topology with unresolved-target refresh;
- semantic change classification and targeted invalidation;
- `SemanticQueryEngine` as the semantic query boundary;
- query-result caching with semantic dependency snapshots;
- update coalescing and stale filesystem-update protection;
- a GDScript builtin catalog;
- Godot native documentation/symbol fallback;
- Godot LSP lifecycle, cancellation, and profiling infrastructure;
- real-project benchmark tooling and Godot 3/4 compatibility fixtures.

Target flow:

```text
VS Code Providers
        │
        ▼
  LanguageService
        │
        ▼
 Semantic Query Engine
   ┌────┼───────────────┐
   ▼    ▼               ▼
Project Builtin      Godot API
Scope   Scope           Scope
   └───────┬───────────────┘
           ▼
 Incremental Semantic DB
           │
           ▼
 Parser / Analyzer
           │
           ▼
 Godot LSP fallback
```

The objective is not to replace Godot LSP for ideological reasons. It is to make LSP unnecessary for common project-level semantics while preserving it for engine-native, dynamic, ambiguous, or unsupported cases.

## 2. Implementation status

| Phase | Status | Current state |
| --- | --- | --- |
| A — LSP audit & observability | **Foundation implemented** | Provider/LSP profiling and request instrumentation exist. |
| B — Semantic Query Engine | **Implemented** | Central query boundary and local resolution are in place. |
| C — Confidence-aware resolution | **Foundation implemented** | Exact/inferred/partial/unknown routing is centralized. |
| D — Provider migration | **Mostly implemented** | Interactive providers are local-first; explicit fallback remains for unresolved cases. |
| E — Incremental semantic DB | **Substantially implemented** | Stable snapshots, fingerprints, indexes, and targeted invalidation exist. |
| F — Dependency-aware invalidation | **Foundation implemented** | Transitive invalidation and unresolved dependency refresh exist. |
| G — Completion & interactive latency | **Foundation implemented** | Cancellation, caching, profiling, stale-result protection, and rapid-typing benchmarks exist. |
| H — LSP transport hardening | **Foundation implemented** | Lifecycle generations, cancellation, bounded requests, and stale-client protection exist. |
| I — Large-project scalability | **Benchmark infrastructure implemented** | Synthetic and real-project runners exist; representative measurements remain. |
| J — Worker-thread evaluation | **Deferred / evidence-driven** | Only justified by CPU profiling. |
| K — Godot compatibility matrix | **Fixture foundation implemented** | Godot 3/4 representative semantic fixtures are formalized. |
| L — Release quality | **Ongoing** | CI, packaging, version validation, and release quality continue to evolve. |

## 3. Language intelligence coverage

### Project scope

Local analysis currently covers:

- declarations and bindings;
- symbol lookup;
- references;
- inheritance-aware members;
- explicit and inferred local types;
- literals and common constructors;
- `Type.new()`;
- `preload(...).new()`;
- conservative `load(...)` inference;
- conditional expressions when both branches agree;
- assignment and simple branch propagation;
- local function return inference;
- member-call return propagation;
- completion, hover, definition, references, rename, and signature help through the semantic query boundary.

### GDScript builtin scope

A builtin catalog now provides local intelligence for common language-level functions such as `abs`, `clamp`, `lerp`, `load`, `preload`, `print`, and `typeof`, including completion/hover/signature-help metadata.

Builtin return-type propagation into the general type-resolution graph remains an explicit follow-up item.

### Godot Engine API scope

Native Godot classes are available through the documentation model, and native symbol navigation is being connected to class/member documentation.

The immediate coverage goal is:

```text
Native class
   ↓
method / property / signal / constant
   ↓
class documentation + member anchor
```

The long-term goal is to make this a first-class local Godot API scope shared by completion, hover, definition, and signature help, rather than querying LSP independently for each feature.

## 4. Definition navigation policy

Definition routing is explicitly layered:

```text
project symbol
    → local source definition

Godot native class
    → .gddoc class documentation

Godot native member
    → .gddoc member documentation

local model incomplete
    → bounded Godot LSP fallback
```

LanguageClient automatic interactive providers are intentionally disabled for features owned by the local architecture. This prevents duplicate Hover/Definition/Completion results while retaining the LSP transport for explicit fallback requests.

## 5. Confidence-aware routing

```text
exact
  → local

safe inferred
  → local

partial / ambiguous
  → fallback

unknown / unsupported
  → Godot LSP
```

Empty results are not automatically authoritative. A built-in receiver that cannot be modeled locally must remain unresolved so that a fallback can answer it.

## 6. Performance and scalability

Required evidence workloads:

```text
100 files
500 files
1,000 files
5,000 files
```

Measure:

- cold indexing;
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
- dependency/API changes;
- p50/p95/p99 latency;
- extension-host CPU and memory;
- LSP fallback frequency.

Engineering budgets:

| Operation | Target |
| --- | ---: |
| Completion | <30 ms |
| Hover | <20 ms |
| Definition | <25 ms |
| LSP fallback | <300 ms |

These are targets, not measured guarantees. Real-project evidence is required before claiming the budget is achieved.

## 7. LSP hardening

Fallback must be predictable rather than dominant.

Required properties:

- one managed connection lifecycle per workspace context;
- generation-aware startup/reconnect;
- stale-client event rejection;
- cancellation propagation;
- bounded fallback requests;
- clear transport-failure versus semantic-unknown distinction;
- instrumentation for every fallback request;
- disposal of managed processes and listeners.

Never solve a lifecycle problem by silently dropping a response that leaves the caller's Promise unresolved.

## 8. Godot compatibility

The semantic analyzer must remain compatible with the Godot generations supported by the extension. Representative fixtures cover Godot 3-style `export`, `onready`, and `yield`, plus Godot 4-style annotations, `@export`, `@onready`, typed returns, and `await`.

Expand fixtures from real compatibility regressions rather than speculative syntax coverage.

## 9. Next development gate

The architecture is now sufficiently established to move from broad restructuring to evidence-driven semantic coverage and performance validation.

1. run the real-project benchmark against representative projects;
2. collect p50/p95/p99, CPU/memory, and LSP fallback frequency;
3. add provider-level routing counters where profiling is insufficient;
4. expand native Godot API modeling for methods, properties, signals, and constants;
5. add regression fixtures for native-member navigation and compatibility failures;
6. add builtin return-type propagation to `TypeResolutionIndex`;
7. improve expression/range parsing only where measured gaps exist;
8. harden LSP failure/cancellation from measured failures;
9. reconsider persistent disk caching or worker threads only if evidence justifies them.

## 10. Explicitly deferred

Do not implement these for theoretical completeness:

- a complete replacement for Godot's semantic engine;
- a full GDScript compiler;
- compiler-equivalent whole-program control-flow analysis;
- speculative dynamic dispatch;
- generic/union type machinery without concrete requirements;
- persistent caches before startup measurements justify them;
- worker threads before CPU profiling justifies them;
- a second language server solely for architectural purity.

## 11. Architectural success criterion

Normal editing should follow:

```text
Editor event
    ↓
Incremental document snapshot
    ↓
Local parser/analyzer
    ↓
Incremental semantic indexes
    ↓
Semantic Query Engine
    ↓
Local provider result
```

Godot LSP should primarily handle:

```text
engine-native semantics not yet modeled locally
        OR
unsupported constructs
        OR
ambiguous/dynamic semantics
        OR
local semantic model unavailable
```

> **Long-term metric:** make Godot LSP unnecessary for the common case while keeping it authoritative for hard cases.
