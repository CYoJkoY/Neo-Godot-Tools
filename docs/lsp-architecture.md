# GDScript local-first language architecture

Neo-Godot-Tools keeps common GDScript editor intelligence local and uses Godot LSP only when the local model cannot answer safely.

```text
VS Code Providers
        │
        ▼
  LanguageService
   /      |       \
Local Index  Type Resolution  Dependency Graph
   \      |      /
 Symbol + Binding + Reference
              │
           Analyzer
              │
            Parser
              │
      Godot LSP fallback
```

## Phase 10 — Semantic scheduling and incremental update coalescing

Phase 10 adds an update scheduler between VS Code events and the local index. The goal is to prevent the same `.gd` file from being reparsed repeatedly during a burst of edits, and to prevent a slow filesystem read from overwriting a newer in-memory document.

### Per-file coalescing

`UpdateScheduler` keeps at most one pending update per URI. Text-document changes, saves, and filesystem watcher events therefore converge on the newest queued version instead of producing one parse/index cycle per event.

A short 30 ms debounce absorbs normal editor event bursts without making the local model feel stale during interactive editing.

```text
text change v1 ─┐
text change v2 ─┼─> UpdateScheduler ──> apply v2 once
save v2 ────────┘
```

### Version and generation safety

Document updates carry the VS Code document version. Older pending versions cannot replace a newer pending version. Filesystem watcher events use version `0`, so they cannot displace a newer open-document update.

Each scheduled item also has a monotonic sequence. If an asynchronous filesystem read is still running when a newer update arrives, the old item becomes stale and the service checks that sequence again before mutating the indexes.

```text
filesystem read v0 ────────┐
                           │ slow I/O
text change v7 ─> queue v7 ├─> v0 discarded
                           │
                           └──────────────> apply v7
```

This is important because debouncing alone does not solve races created by asynchronous file-system operations.

### Event ownership

Open GDScript documents are treated as the authoritative source for their URI. A filesystem watcher event for an open document is converted into the current document update rather than reading a potentially stale on-disk copy.

Deletion cancels all pending work for the URI before removing its indexes and invalidating dependent semantic caches.

### Interaction with Phase 9

Scheduling does not change the semantic invalidation model. Once an update is accepted, the existing pipeline remains:

```text
TextDocument / File Watcher
          │
          ▼
   UpdateScheduler
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

Dependency-aware invalidation therefore still happens only after a coalesced update is committed. Dependents are not eagerly reparsed just because an upstream file changed.

### Why workers are still not added

The scheduler reduces redundant work, but it does not move parsing to another thread. This is intentional. The next optimization should be driven by measurements rather than by adding concurrency prematurely.

Profile these separately:

1. initial workspace discovery and indexing;
2. parser time for one changed file;
3. binding/reference/index update time;
4. semantic cache invalidation and recomputation;
5. extension-host latency during rapid edits.

If parser/index CPU time is the dominant cost after coalescing, `worker_threads` becomes the next architectural option. If I/O or Godot LSP fallback dominates, moving the parser to a worker would not address the real bottleneck.

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

Phase 10 does not add persistent disk caches, a full GDScript type lattice, control-flow analysis, generic/union types, engine API indexing, or worker threads. The scheduler is deliberately small and independent of VS Code so its correctness can be tested without the extension host.
