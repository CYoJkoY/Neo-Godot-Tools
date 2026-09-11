# Semantic Benchmarking

Neo-Godot-Tools now provides a repeatable benchmark path for measuring the local-first semantic architecture on real Godot projects.

## Real project benchmark

Run:

```bash
ts-node tools/semantic_project_benchmark.ts <path-to-godot-project>
```

Optional file limit:

```bash
ts-node tools/semantic_project_benchmark.ts <path-to-godot-project> --max-files 1000
```

The runner excludes `.git`, `node_modules`, and `.godot`, indexes every `.gd` file, then reports:

- cold indexing latency;
- incremental single-file edit latency;
- rapid-typing update + completion latency;
- type, definition, hover, and completion query latency;
- p50/p95/p99/max for each workload.

The benchmark intentionally exercises the same `FileIndex` → `SymbolIndex` → `BindingIndex` → `TypeResolutionIndex` → `SemanticQueryEngine` path used by the local semantic architecture.

## Target budgets

The roadmap targets:

| Workload | Target |
| --- | ---: |
| Completion | < 30 ms |
| Hover | < 20 ms |
| Definition | < 25 ms |
| LSP fallback | < 300 ms |
| 100 files | < 200 ms |
| 500 files | < 800 ms |
| 1,000 files | < 1.5 s |
| 5,000 files | < 4 s |

These are engineering budgets, not guarantees. Measurements must be collected on representative projects and hardware before architectural decisions are made.

## Interpreting fallback usage

The extension profiler already separates local semantic measurements from `lsp.fallback.*` measurements. A high fallback rate is not automatically a failure: dynamic, engine-native, ambiguous, or unsupported semantics are expected fallback cases.

The important signals are:

1. common project-level queries should resolve locally;
2. ambiguous results should fall back instead of returning a guessed result;
3. fallback latency should remain bounded;
4. repeated local queries should benefit from dependency-aware cache validation;
5. rapid typing must not allow stale work to overwrite newer state.

## Compatibility fixtures

`test_fixtures/semantic/` contains representative Godot 3 and Godot 4 scripts. `src/index/compatibility_fixture.test.ts` verifies that both generations can be parsed and indexed while preserving representative local type semantics.

The fixture suite is deliberately small. Add a syntax or semantic fixture when a real project exposes a compatibility regression rather than trying to enumerate the entire GDScript grammar.

## What should happen next

1. Run the real-project benchmark on representative small, medium, and large Godot projects.
2. Record p50/p95/p99 results and fallback counts.
3. Investigate only workloads that exceed the target budget.
4. Add compatibility fixtures for observed Godot 3.x/4.x failures.
5. Consider persistent disk caching or worker threads only when measurements demonstrate that startup I/O or CPU saturation is the actual bottleneck.
