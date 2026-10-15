# Semantic Benchmarking

Neo-Godot-Tools provides a repeatable local semantic benchmark for real Godot projects. Use it to compare representative project sizes and to decide which workloads need optimization based on measurements rather than assumptions.

## Run a benchmark

From the repository root:

```bash
ts-node tools/semantic_project_benchmark.ts <path-to-godot-project>
```

Limit the run to a deterministic prefix of the sorted script paths and save a JSON report:

```bash
ts-node tools/semantic_project_benchmark.ts <path-to-godot-project> --max-files 1000 --output ./.benchmark/semantic-1000.json
```

The output directory must already exist. The report is printed to stdout and, when `--output` is supplied, written to that file as well. The report does not include the absolute project path and the tool does not upload source files or results anywhere.

Run separate samples for each desired size:

```bash
ts-node tools/semantic_project_benchmark.ts <project> --max-files 100 --output ./.benchmark/semantic-100.json
ts-node tools/semantic_project_benchmark.ts <project> --max-files 500 --output ./.benchmark/semantic-500.json
ts-node tools/semantic_project_benchmark.ts <project> --max-files 1000 --output ./.benchmark/semantic-1000.json
ts-node tools/semantic_project_benchmark.ts <project> --max-files 5000 --output ./.benchmark/semantic-5000.json
```

The runner excludes `.git`, `node_modules`, and `.godot`, indexes `.gd` files in sorted path order, and reports:
- cold indexing time, including source reads and index construction;
- incremental single-file edit latency;
- update + completion latency during a burst of valid comment edits;
- local type, definition, hover, and completion query latency at declaration sites sampled across the indexed workspace;
- p50/p95/p99/max, sample counts, runtime/OS/CPU metadata, source-byte counts, and memory snapshots after indexing and after the workloads.

The standalone benchmark uses the same `FileIndex` → `SymbolIndex` → `BindingIndex` → `TypeResolutionIndex` → `SemanticQueryEngine` path as the local semantic architecture, including the GDScript builtin return-type catalog.

## Reading query metrics

- `uncachedSemanticMs` clears the semantic query cache and type-resolution caches before each query measurement. File indexes, bindings, and lexical/token caches remain constructed; this is **not** a fresh-process cold start.
- `warmSemanticMs` measures repeated queries after explicit warm-up rounds and therefore represents the warmed query path.
- `coldIndexMs` covers reading and indexing the selected scripts in the current process.
- `memoryBytes` contains process snapshots at two checkpoints; these are not a sampled peak-memory profile.

These numbers are local-engine measurements, not end-to-end VS Code responsiveness. The tool does not start the VS Code extension host or send Godot LSP requests, so it cannot report `lsp.fallback.*` counts or engine round-trip latency.

## Target budgets

The roadmap's engineering targets are:

| Workload | Target |
| --- | ---: |
| Completion | < 30 ms |
| Hover | < 20 ms |
| Definition | < 25 ms |
| Godot LSP fallback | < 300 ms |
| 100 files | < 200 ms |
| 500 files | < 800 ms |
| 1,000 files | < 1.5 s |
| 5,000 files | < 4 s |

These are engineering budgets, not guarantees. The file-count targets apply to cold indexing; the interactive targets should be compared with query latency measured in an actual extension-host session, not inferred from standalone benchmark results.

## LSP and interactive evidence

The runtime profiler records local parse/index/provider measurements and Godot LSP request latency. Those metrics are collected in memory by the running extension; the standalone project benchmark cannot substitute for them.

For a useful performance review, record:
1. the same project's standalone indexing and uncached/warm query JSON reports;
2. actual VS Code completion, hover, definition and edit-burst behavior;
3. LSP request counts and p50/p95/p99 latency from the extension runtime;
4. extension-host CPU and memory during the same workload.

A high LSP fallback rate is not automatically a failure: dynamic, engine-native, ambiguous, or unsupported semantics are expected fallback cases. Common project-level queries should resolve locally, ambiguous results should fall back instead of returning a guess, and fallback latency should remain bounded.

## Compatibility fixtures

`test_fixtures/semantic/` contains representative Godot 3 and Godot 4 scripts. `src/index/compatibility_fixture.test.ts` verifies that both generations can be parsed and indexed while preserving representative local type semantics.

The fixture suite is deliberately small. Add a syntax or semantic fixture when a real project exposes a compatibility regression rather than trying to enumerate the entire GDScript grammar.

## Next decisions

1. Run the benchmark on representative small, medium, and large projects and retain the JSON reports locally.
2. Compare p50/p95/p99 and memory snapshots across runs on the same machine and runtime.
3. Collect extension-host LSP/runtime measurements separately before drawing conclusions about fallback behavior.
4. Investigate only workloads that exceed the target budget.
5. Consider persistent disk caching or worker threads only when the measurements demonstrate that startup I/O or CPU saturation is the actual bottleneck.
