# GDScript Local-First Language Architecture

Neo-Godot-Tools keeps common GDScript editor intelligence local and uses Godot LSP only when the local model cannot answer safely.

## Architecture

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
      Dependency Graph
           │
      File / AST Index
           │
      GDScript Parser
           │
           ├─────────────── local result
           │
           ▼
     Godot LSP fallback
```

The architecture is semantic rather than transport-oriented. VS Code providers call `LanguageService`; the service queries the local semantic model; only unresolved or unsafe cases cross the LSP boundary.

## Three semantic scopes

The language system is organized conceptually into:

```text
GDScript Builtin Scope
        │
Godot Engine API Scope
        │
Project Scope
        │
        ▼
Semantic Query Engine
```

**GDScript Builtin Scope** covers language-level functions and built-in constructs.

**Godot Engine API Scope** covers native classes, methods, properties, signals, constants, and documentation. This is currently the largest local semantic coverage gap and is being expanded incrementally.

**Project Scope** covers user scripts and project-defined symbols through local indexes.

## Local-first provider routing

The extension deliberately disables the LanguageClient's automatic interactive providers for features owned by the local architecture. This prevents VS Code from merging independent local and LSP results into duplicate Hover/Definition/Completion UI.

The LSP client remains active as a transport and fallback channel. Explicit fallback requests continue to use `sendRequest()` with cancellation and bounded timeouts.

```text
Local provider
    │
    ├── exact / safe inferred → return
    │
    └── partial / unknown
              ↓
       explicit LSP request
```

This is the central architectural rule: **LSP is a fallback dependency, not a second peer provider implementation.**

## Definition navigation

Definition navigation distinguishes project symbols from native Godot API symbols.

### Project symbols

```text
Ctrl+Click MyPlayer
        ↓
SemanticQueryEngine
        ↓
Project Scope
        ↓
source Location
```

### Native classes

```text
Ctrl+Click Node
        ↓
Native symbol resolution
        ↓
Node.gddoc
```

### Native members

```text
Ctrl+Click node.add_child
        ↓
Native symbol resolution
        ↓
Node.add_child
        ↓
Node.gddoc#add_child
```

The native lookup is bounded and cancellation-aware. If native symbol resolution fails, the provider returns no fabricated location rather than opening an unrelated project file.

## Incremental update pipeline

```text
Text change / save / filesystem event
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

Updates are coalesced by URI, and newer in-memory document state is protected from stale asynchronous filesystem reads.

## Dependency topology

`DependencyGraph` maintains both resolved edges and unresolved candidates.

```text
extends / preload
       ↓
   resolve target
   ┌────┴────┐
   ▼         ▼
resolved  unresolved
 edge       candidate
   │          │
   │          └── target appears → refresh candidates
   └───────────── target changes/removes → invalidate dependents
```

This keeps ordinary edits incremental instead of rebuilding the workspace graph.

## Semantic cache

Query results are validated against the semantic state they actually depend on:

```text
Query
  ↓
cache entry
  ├── source/API snapshot
  ├── symbol lookup signatures
  ├── completion signatures
  └── receiver snapshots
```

A cache hit requires every recorded dependency to remain unchanged.

## Type inference

The local resolver currently supports explicit and inferred declarations, literals, constructors, `preload`, conservative `load`, conditional expressions, assignments, simple branches, local returns, member-call returns, declared member types, and inheritance-aware lookup.

The intended behavior is conservative:

```text
provable type → resolve locally
ambiguous type → unknown → LSP fallback
```

The analyzer should not grow compiler-equivalent control-flow or speculative dynamic dispatch merely to increase a benchmark's local hit rate.

## LSP lifecycle

`GDScriptLanguageClient` and `ClientConnectionManager` own transport and lifecycle concerns:

- one managed connection lifecycle per workspace context;
- generation-aware startup/reconnect;
- stale-client event rejection;
- request cancellation;
- bounded fallback requests;
- request instrumentation;
- managed process disposal.

The semantic engine itself remains unaware of LSP transport details.

## Performance strategy

Optimization proceeds in this order:

```text
semantic correctness
        ↓
incremental invalidation
        ↓
query dependency caching
        ↓
interactive latency measurement
        ↓
real-project benchmarks
        ↓
workers / persistent cache only if justified
```

Current targets are approximately <30 ms completion, <20 ms hover, <25 ms definition, and <300 ms for an LSP fallback. These are engineering budgets, not measured guarantees; real-project p50/p95/p99 data is required before declaring them achieved.

## Non-goals

- replacing Godot's entire semantic engine;
- implementing a complete GDScript compiler;
- maintaining a second full language server;
- adding worker threads without CPU evidence;
- adding persistent caches without startup measurements;
- speculative type machinery without concrete editor use cases.
