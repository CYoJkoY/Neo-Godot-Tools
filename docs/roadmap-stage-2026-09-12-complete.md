# Roadmap Stage — 2026-09-12: Local semantic hardening

This stage extends the range-aware type-inference work with the next correctness and scalability layer described by `docs/development-roadmap.md`.

## Implemented

### Control-flow-aware local type propagation

The local type resolver now recognizes simple `if` / `elif` / `else` assignment branches inside a function body. A variable assigned in every branch is considered resolvable only when all branch expressions resolve to the same type. A branch without an `else` remains conservative and falls back instead of guessing.

This keeps the local analyzer useful for common code while preserving the roadmap's rule that ambiguous control flow must not produce confidently wrong results.

### Explicit confidence routing

`LanguageService` now uses a shared confidence policy for definition and hover results:

- `exact` and `inferred` are safe local results;
- `partial` and `unknown` continue to the Godot LSP fallback.

The policy is centralized and regression-tested rather than duplicated in providers.

### LSP stale-response rejection

Interactive fallback methods now track the latest request per method. Older responses for completion, hover, definition, references, rename, and signature help are discarded before reaching VS Code. Request latency remains instrumented, and the request-generation state is cleared on disconnect.

This addresses the remaining stale-response correctness requirement without making LSP the primary semantic path.

### Large-project benchmark matrix

Added `tools/semantic_scale_benchmark.ts`, which measures synthetic 100 / 500 / 1,000 / 5,000-file workspaces for:

- cold indexing;
- single-file incremental edits;
- semantic type-query latency;
- p50/p95/p99 values.

The benchmark is intentionally dependency-free and runs against the same local indexes used by the extension.

## Deliberately deferred

The following remain conditional on benchmark evidence:

- persistent disk semantic caches;
- worker threads;
- whole-program control-flow analysis;
- generic/union type inference;
- compiler-equivalent expression ASTs.

The next architectural priority after this stage is to use real project measurements to tune provider-boundary latency and decide whether the parser/index path is actually CPU-bound.
