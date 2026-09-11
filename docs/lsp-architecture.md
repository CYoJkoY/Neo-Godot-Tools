# GDScript local-first language architecture

Neo-Godot-Tools keeps common GDScript editor intelligence local and uses Godot LSP only when the local model cannot answer safely.

```text
VS Code Providers
        │
        ▼
  LanguageService
   /      |       \
Local Index  Type Resolution  Dependency Graph
   \      |       /
 Symbol + Binding + Reference
              │
           Analyzer
              │
            Parser
              │
      Godot LSP fallback
```

## Phase 9 — Semantic cache and dependency-aware invalidation

Phase 9 adds a cache layer to the local semantic model without introducing persistent state or background workers prematurely. The goal is to make repeated Definition/Hover/Completion requests cheap while keeping results correct after incremental edits.

### Version-aware semantic cache

`TypeResolutionIndex` now caches two expensive classes of results:

- script-name resolution;
- inheritance-aware member collections.

Name-cache entries are validated against the current symbol declaration signature. Member-cache entries carry a recursive file-version signature through the local `extends` chain. A change to a base script therefore makes cached members of derived scripts stale automatically.

This avoids rebuilding inherited member lists on every editor request while preserving correctness across incremental updates.

### Dependency-aware invalidation

`DependencyGraph.getTransitiveDependents()` identifies all local scripts affected by a changed dependency. `LanguageService` captures that set before updating the dependency graph and invalidates semantic entries for the changed file and its dependents.

Deletion follows the same boundary so removed scripts cannot leave stale semantic results behind.

```text
change base.gd
      │
      ▼
DependencyGraph
      │
      ├── player.gd
      ├── enemy.gd
      └── game.gd
      │
      ▼
TypeResolutionIndex.invalidate()
      │
      ▼
recompute only when queried
```

The cache is intentionally demand-driven. We do not eagerly reparse every dependent file merely because an upstream symbol changed.

### Incremental update boundary

The update pipeline remains:

```text
TextDocument / File Watcher
          │
          ▼
       FileIndex
          │
    ┌─────┼──────────────┐
    ▼     ▼              ▼
 Symbols Bindings    References
          │
          ▼
   DependencyGraph
          │
          ▼
 TypeResolutionIndex
```

A changed file is parsed and indexed once. Semantic caches are then invalidated at the dependency boundary. Subsequent requests recompute only the semantic result that is actually needed.

### Why workers are not added yet

The current architecture still performs parser/index updates synchronously. Phase 9 therefore does not add `worker_threads` merely for theoretical performance. The next decision should be based on profiling real projects:

1. measure initial workspace indexing;
2. measure single-file edit latency;
3. measure repeated hover/completion latency with and without cache hits;
4. measure CPU time spent in parser, bindings, references, and semantic resolution.

Only if parsing/indexing is demonstrably CPU-bound should the scheduler move work off the extension host thread.

## Provider behavior

Definition, hover, and member completion continue to follow this order:

```text
local binding / expression
          ↓
     local script type
          ↓
   cached semantic members
          ↓
 inherited local members
          ↓
      local symbol
          ↓
     Godot LSP fallback
```

Native engine classes, dynamic values, ambiguous class names, unsupported expressions, and unresolved dependencies intentionally fall through to Godot LSP.

## Deliberate limits

Phase 9 does not add persistent disk caches, a full GDScript type lattice, control-flow analysis, generic/union types, or engine API indexing. Cache entries are derived entirely from the in-memory indexes and are discarded with the language service.

The next stage should focus on **semantic scheduling and profiling**, especially coalescing bursts of text changes and moving only proven CPU-heavy indexing work off the VS Code extension host thread. Rust should remain a profiling-driven option rather than an architectural prerequisite.
