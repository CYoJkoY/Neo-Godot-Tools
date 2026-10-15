# Comparing Semantic Benchmark Reports

The project benchmark writes schema-versioned JSON reports. Compare two local reports with:

```bash
npm run compare:semantic-benchmarks -- ./.benchmark/semantic-baseline.json ./.benchmark/semantic-current.json
```

The command prints a Markdown summary to stdout with baseline/current values and relative latency changes for:
- cold indexing;
- single-file edits and rapid-typing completion;
- uncached and warmed type, definition, hover, and completion queries;
- p50, p95, p99, and maximum latency.

Positive percentages mean the current run took longer; negative percentages mean it was faster. When the baseline metric is zero, the percentage is shown as unavailable rather than dividing by zero.

The header identifies whether the reports use the same Node version, operating system, architecture, and CPU model. It separately reports project workload comparability using the project name, indexed GDScript file count, and indexed source-byte count. The Godot version is reported on both sides, and version comparability is `unknown` when either report does not include that optional metadata.

A `yes` workload indicator is only a shape check: equal file counts and byte totals do not prove that source content is identical. Engine-version differences or missing version metadata should also prevent treating the comparison as apples-to-apples. The CLI still emits all metric deltas as diagnostics when the environment or workload differs.

The report validator rejects non-finite or negative durations, non-integer/negative file counts and source-byte counts, and percentile summaries that violate `p50 <= p95 <= p99 <= max`. Optional Godot-version metadata must use the version format emitted by the benchmark runner.

Use reports produced by the same benchmark schema. Compare runs from the same machine and similar background load whenever possible. Keep report files local unless you have deliberately reviewed them before sharing; the comparator does not upload reports or source code.

This command compares standalone local semantic measurements only. It cannot compare Godot LSP fallback counts or replace end-to-end measurements from the running VS Code extension.
