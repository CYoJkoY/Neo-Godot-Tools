# Roadmap Batch — 2026-09-12

This batch advances the local-first architecture directly from the current roadmap state.

## Implemented

### Type inference expansion

- Added `NodePath` and `PackedVector4Array` to the known built-in type model.
- Added `NodePath(...)` construction inference.
- Added `Type.new(...)` inference for user-defined `class_name` scripts and known built-in constructors.
- Added conservative GDScript conditional-expression inference (`a if condition else b`) when both branches resolve to the same type.
- Kept ambiguous expressions unresolved rather than guessing.
- Made inherited-member cache signatures include the source fingerprint as well as the API fingerprint. This prevents stale member/return-type state when an untyped function's inferred return type changes in a body-only edit.

### Confidence-aware routing

- Member completion now returns `unknown` for built-in receivers that the local index cannot model instead of returning an authoritative empty result.
- Empty member sets no longer produce a misleading `exact` completion result.
- Language-service routing continues to use local results only for `exact`/safe `inferred` results and falls back for unresolved cases.

### Interactive latency and cancellation

- Completion requests now observe VS Code cancellation before and after local semantic work.
- Signature-help requests observe cancellation before local semantic work and before fallback.
- Rename checks cancellation while constructing edits.
- Semantic and LSP fallback paths are now separately measured through the existing runtime profiler.
- Semantic invalidation now explicitly includes the changed file as well as affected dependents.

### LSP lifecycle hardening

- Reconnect timers are owned by the connection manager and cleared during disposal.
- Headless-LSP startup is generation-aware, preventing an obsolete asynchronous startup from reconnecting after a newer lifecycle has begun.
- Disposal stops the managed LSP process and client listeners.
- Manual start/restart paths share the same lifecycle generation mechanism instead of launching overlapping startup flows.

## Deliberately deferred

The following remain evidence-driven rather than being implemented speculatively:

- persistent disk semantic caches;
- worker threads;
- a complete Godot API database;
- compiler-equivalent control-flow/type analysis;
- generic/union types;
- formal 100/500/1K/5K-file benchmark execution against real projects.

These require measured workloads or broader semantic infrastructure before they can be implemented safely.
