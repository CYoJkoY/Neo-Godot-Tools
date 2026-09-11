# Roadmap Batch — 2026-09-12

This batch records the current local-first semantic milestone and the follow-up work required to make Godot native API navigation complete without reintroducing duplicate providers or unbounded LSP requests.

## Implemented

### Local semantic foundation

- Centralized semantic queries behind `SemanticQueryEngine`.
- Added incremental source/API snapshots and targeted invalidation.
- Added dependency-aware semantic caching.
- Added conservative type inference for common GDScript expressions and propagation paths.
- Added confidence-aware routing so unresolved local results can fall back instead of being treated as authoritative.

### GDScript builtin intelligence

- Added a local catalog for common GDScript builtin functions.
- Builtin metadata participates in completion, hover, and signature help.
- Kept builtin return-type propagation into the general type resolver as follow-up work rather than adding speculative inference.

### Godot native documentation navigation

- Native Godot classes can resolve to the extension's `.gddoc` documentation viewer.
- Native methods/properties/constants are being resolved through the Godot semantic channel and normalized to class/member documentation targets.
- Native symbol requests are cancellation-aware and bounded to prevent Ctrl+Click from accumulating indefinitely pending requests.

### Provider/LSP separation

- LanguageClient automatic interactive providers are disabled for features owned by the local-first architecture.
- Explicit LSP requests remain available to `LanguageService` and specialized fallbacks.
- This prevents VS Code from merging independent local and LSP Hover/Definition/Completion results into duplicate UI.
- Stale LSP responses are no longer silently discarded in a way that could leave caller promises unresolved.

### LSP lifecycle hardening

- Reconnect timers are owned by the connection manager and cleared during disposal.
- Headless-LSP startup is generation-aware.
- Manual start/restart paths share lifecycle generation state.
- Stale-client events are rejected after replacement.
- Fallback requests use cancellation and bounded timeouts.

### Evidence infrastructure

- Added a real-project semantic benchmark runner.
- Added rapid-typing measurements.
- Added Godot 3/4 semantic compatibility fixtures.
- Added runtime instrumentation for local semantic and LSP fallback paths.

## Current gaps

The remaining native-language-intelligence gap is not basic class navigation. It is complete **Godot Engine API Scope** coverage:

```text
Native class
   ↓
method / property / signal / constant
   ↓
completion / hover / signature help / definition
   ↓
class documentation + member anchor
```

Specific follow-ups:

- native member metadata model shared across providers;
- native member completion;
- native member hover;
- native signature help;
- more reliable native method/property/constant identification;
- builtin function return-type propagation;
- regression fixtures for native member Ctrl+Click;
- measured fallback frequency by provider.

## Deliberately deferred

- persistent disk semantic caches;
- worker threads;
- compiler-equivalent control-flow/type analysis;
- generic/union types without concrete requirements;
- a complete independent Godot API database without a clear synchronization strategy;
- broad parser complexity that is not justified by measured compatibility failures.

## Next evidence gate

1. Verify native class and member Ctrl+Click behavior in real Godot 3.x and 4.x projects.
2. Run the real-project semantic benchmark.
3. Measure p50/p95/p99, CPU/memory, and LSP fallback frequency.
4. Add native-member regression fixtures for every confirmed failure mode.
5. Expand the Godot API scope only where it improves multiple language features at once.
6. Revisit persistent caching or workers only after performance evidence demonstrates a need.
