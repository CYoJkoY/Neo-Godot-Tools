# GDScript Local-First Language Architecture

Neo-Godot-Tools keeps common GDScript editor intelligence local and uses Godot LSP only when the local model cannot answer safely.

## Current architecture

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
Symbol Binding      Reference
Index   Index          Index
   │       │              │
   └───────┼──────────────┘
           ▼
   Type Resolution
           │
           ▼
 Dependency Graph
           │
           ▼
    File / AST Index
           │
           ▼
      GDScript Parser
           │
           ▼
   Godot LSP fallback
```

The important boundary is semantic rather than transport-oriented:

```text
VS Code API
     ↓
LanguageService
     ↓
SemanticQueryEngine
     ↓
local semantic indexes
     ↓
parser / analyzer
```

Godot LSP remains outside the local hot path and is used for engine-native, dynamic, ambiguous, unsupported, or otherwise unresolved semantics.

## Incremental update pipeline

Editor and filesystem events are coalesced before semantic work begins:

```text
Text change / save / file watcher
              ↓
       UpdateScheduler
              ↓
          FileIndex
              ↓
     SemanticChangeKind
        ┌─────┼─────────────┐
        ▼     ▼             ▼
     body   API/deps     add/remove
      │       │             │
      ▼       ▼             ▼
 current   affected      affected
  file     dependents    topology
```

`UpdateScheduler` keeps at most one pending update per URI and protects newer in-memory document state from stale asynchronous filesystem reads. Once an update is accepted, the semantic change classifier determines the minimum required downstream work.

## Semantic change model

The index distinguishes:

```text
unchanged
body_changed
api_changed
dependency_changed
file_added
file_removed
```

API fingerprints represent public semantic shape rather than document version. A body-only edit can therefore avoid invalidating transitive dependents.

```text
body edit
   ↓
new source snapshot
   ↓
API fingerprint unchanged
   ↓
no dependent semantic invalidation
```

For an API change:

```text
API change
   ↓
DependencyGraph
   ↓
transitive dependents
   ↓
TypeResolutionIndex + SemanticQueryEngine invalidation
```

## Dependency topology

`DependencyGraph` maintains both resolved edges and unresolved candidates.

```text
preload / extends
       ↓
 resolve target
   ┌───┴────┐
   ▼        ▼
resolved  unresolved
 edge      candidate
   │          │
   │          └── target added → refresh candidate dependents
   └──────────── target removed → preserve candidate for re-resolution
```

This avoids a workspace-wide dependency rebuild when a script is added or removed.

## Semantic Query Engine

The query engine is the single semantic boundary used by the local-first providers. Its role is to combine indexes, perform deterministic resolution, expose confidence, and provide a controlled fallback boundary.

Core operations currently include:

```text
getSymbol(uri, position)
getDefinition(...)
getReferences(...)
getHover(...)
getCompletions(...)
```

Type and member resolution is supplied by `TypeResolutionIndex`.

### Query result confidence

Semantic results use an explicit confidence model:

```text
exact
inferred
partial
unknown
```

The intended routing is:

```text
local result
    │
    ├── exact / safe inferred → local provider result
    │
    └── partial / unknown ───→ Godot LSP fallback
```

The confidence model is intentionally conservative. A slower fallback is preferable to an incorrect local definition, hover, completion, or rename operation.

## Semantic cache model

The query cache is no longer keyed only by URI and cursor offset. Each entry records the semantic state it actually depends on.

```text
Query
  ↓
cache entry
  ├── current file source/API snapshot
  ├── global symbol lookup signatures
  ├── workspace completion signatures
  └── resolved receiver file snapshots
```

Validation is dependency-local:

```text
all dependency snapshots unchanged
        ↓
     cache hit

any dependency changed
        ↓
    recompute query
```

Explicit invalidation remains useful for cross-file changes already represented by the dependency graph, while query dependency snapshots protect against stale global symbol/completion results that are not captured by the current document snapshot alone.

## Type resolution

`TypeResolutionIndex` is the next major semantic expansion point. The current foundation resolves declared types, built-in types, local bindings, inherited members, and selected expression forms. The planned expansion adds conservative inference for common GDScript expressions without attempting to become a full compiler.

Target inference chain:

```text
initializer / assignment / return expression
                    ↓
            expression type
                    ↓
          local type resolution
                    ↓
       member / function propagation
                    ↓
          semantic provider result
```

Important cases include:

- typed declarations;
- literal values;
- constructor calls for common built-in value types;
- `preload()` script construction;
- `load()` resources;
- function return propagation;
- member return types;
- inheritance-aware members.

When the expression is ambiguous or outside the local model, resolution must remain unknown and allow Godot LSP to answer.

## Provider routing

The local-first provider surface is now substantially implemented:

| Capability | Local semantic path | Fallback |
| --- | --- | --- |
| Definition | Semantic Query Engine | Godot LSP |
| Hover | Semantic Query Engine | Godot LSP |
| Completion | Semantic Query Engine | Godot LSP |
| References | Semantic Query Engine | Godot LSP |
| Rename | Binding/Reference indexes | Godot LSP |
| Signature Help | local binding/symbol resolution | Godot LSP |
| Document Symbols | FileIndex | provider-specific / none |
| Workspace Symbols | SymbolIndex | intentionally not dependent on Godot LSP |

The remaining work is mainly semantic coverage, confidence policy, cancellation, latency measurement, and hardening—not another provider-wide rewrite.

## LSP boundary

`GDScriptLanguageClient` remains the transport boundary. It is responsible for lifecycle, request transport, result normalization, compatibility behavior, and LSP request instrumentation.

The local semantic engine should not know about VS Code transport details. Conversely, providers should not reproduce semantic resolution that already belongs to the query engine.

## Performance strategy

The optimization order is deliberate:

```text
correct semantic model
        ↓
incremental invalidation
        ↓
query dependency caching
        ↓
interactive latency measurements
        ↓
large-project benchmarks
        ↓
only then consider workers / persistent caches
```

Do not add worker threads merely because parser work is theoretically parallelizable. First establish whether parser/index CPU, I/O, semantic recomputation, or LSP fallback is actually responsible for user-visible latency.

## Current non-goals

This architecture does not attempt to provide:

- a complete replacement for Godot's semantic engine;
- a complete GDScript compiler;
- whole-program control-flow analysis;
- generic/union types without a concrete need;
- persistent disk caches before startup measurements justify them;
- worker threads before CPU profiling justifies them;
- a second language server solely for architectural purity.
