# Roadmap Stage — 2026-09-12

This stage continues the local-first semantic architecture after the completion of the initial type-inference expansion and LSP lifecycle hardening.

## Implemented in this stage

### Range-aware local statement resolution

`TypeResolutionIndex` no longer discovers local assignments and return expressions by scanning arbitrary source text with broad multiline regular expressions.

The local semantic path now:

1. tokenizes the current file with the existing GDScript lexer;
2. restricts analysis to the containing function's `bodyRange`;
3. identifies `var` / `const` initializers, assignments, and `return` statements from token ranges;
4. resolves the latest assignment visible at the requested offset;
5. uses the same range-aware statement model for untyped function return inference.

This prevents comments, string literals, and unrelated source fragments from being mistaken for executable assignments or returns.

The implementation remains intentionally conservative. Multiline/control-flow-sensitive expressions are still unresolved rather than guessed.

### Semantic-core benchmark harness

Added `tools/semantic_benchmark.ts` for repeatable measurements against a real Godot project directory. It reports:

- GDScript file count;
- cold local indexing time;
- repeated single-file edit/update time;
- local semantic query latency;
- p50/p95/p99 values.

The harness deliberately measures the local semantic core independently of VS Code and Godot LSP so architectural regressions can be detected before adding another cache or worker thread.

## Remaining roadmap work

The next evidence-driven work remains:

- real 100 / 500 / 1,000 / 5,000-file benchmark datasets;
- completion/hover/definition/reference/rename latency measurements from the VS Code provider boundary;
- stale-response rejection and request-generation semantics for LSP fallback;
- richer AST statement/expression nodes where lexical ranges are no longer sufficient;
- formal Godot 3.x / 4.x semantic compatibility coverage.

Persistent disk caches and worker threads remain deferred until benchmark data demonstrates that they are necessary.
