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

The header also identifies whether the reports use the same Node version, operating system, architecture, and CPU model, and whether project names and indexed file counts match. These checks are warnings for interpretation, not proof that the workload is identical: project source bytes and Godot version may still differ.

Use reports produced by the same benchmark schema. Compare runs from the same machine and similar background load whenever possible. Keep report files local unless you have deliberately reviewed them before sharing; the comparator does not upload reports or source code.

This command compares standalone local semantic measurements only. It cannot compare Godot LSP fallback counts or replace end-to-end measurements from the running VS Code extension.
