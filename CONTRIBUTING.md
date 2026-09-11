# Contributing

## Development requirements

- [npm](https://www.npmjs.com/get-npm)
- [fgvm](https://fgvm.dev) — Godot version manager for engine-in-the-loop tests
- A Godot installation, managed by fgvm or installed manually

## Development workflow

1. Start from an up-to-date `master` branch.
2. Create a short-lived branch for one logical change.
3. Inspect the affected architecture before editing.
4. Implement the complete change rather than committing each debugging step.
5. Run focused tests while developing.
6. Run the full relevant validation suite before opening the PR.
7. Review the final diff for unrelated changes and generated files.
8. Consolidate temporary commits into logical public commits.
9. Open a pull request against `master`.
10. Merge only after CI is green and the PR is coherent.

Branch names and commit messages follow [Git Workflow and Commit Convention](docs/git-workflow.md).

For a single coherent change, the preferred public history is one logical commit. Multiple commits are appropriate only when each commit is independently meaningful and reviewable.

## Building from source

Download dependencies:

```bash
npm install
```

Package a VSIX:

```bash
npm run package
```

When developing the extension, open the repository in Visual Studio Code and use the `Run Extension` launch configuration. It launches a separate Extension Host with the extension loaded.

If you create `workspace.code-workspace`, the `Run Extension with workspace file` launch configuration can be used to test against a selected Godot project and settings.

## Testing

### Unit tests

Formatter snapshot tests and pure TypeScript tests run without a Godot installation:

```bash
npm test
```

### Engine-in-the-loop tests

Debugger integration tests require a Godot binary managed by fgvm:

```bash
fgvm install 4.7
npm run test:engine -- 4.7
```

Run a specific test pattern:

```bash
npm run test:engine -- 4.7 "typed dict"
npm run test:engine -- 4.7 "built-in types"
```

For Godot 3:

```bash
fgvm install 3.6.2
npm run test:engine -- 3.6.2 --godot3
```

The test runner (`tools/run_tests.ts`) resolves the Godot binary from fgvm, writes the appropriate test settings, compiles the extension, and runs the suite.

### CI

CI runs the relevant OS × Godot-version matrix defined in `.github/workflows/ci.yml`. Keep the matrix representative of the supported Godot versions, especially across Godot 3.x and 4.x compatibility boundaries.

Do not weaken CI checks to make a failing change pass. Fix the underlying project code, tests, or configuration.

## LSP development

The intended GDScript language architecture is documented in:

- [LSP architecture](docs/lsp-architecture.md)
- [Development roadmap](docs/development-roadmap.md)
- [Language performance profiling](docs/performance-profiling.md)

The current direction is local-first:

```text
VS Code Providers
        ↓
LanguageService
        ↓
Semantic Query Engine
        ↓
Incremental Index / Dependency Graph
        ↓
Analyzer / Parser
        ↓
Godot LSP fallback
```

The local model should answer common project-level queries. Godot LSP remains the semantic fallback for engine-native, dynamic, ambiguous, or unsupported cases.

LSP changes should include tests and measurements when they affect scheduling, parsing, indexing, semantic resolution, provider routing, or fallback behavior.

Do not introduce worker threads, persistent caches, or additional concurrency without profiling evidence that the change addresses the actual bottleneck.

## Performance work

Performance changes must be measurable. Prefer p50/p95/p99 latency, CPU time, memory usage, parser/index timings, and Godot LSP request counts over subjective claims.

The repository contains a reproducible language benchmark. Use it when changing parser, analyzer, index, scheduling, or semantic-query performance.

## Release development

`package.json` always contains a clean SemVer version such as `2.8.0`.

Stable tags use `v2.8.0`; development tags use `v2.8.0.dev1`, `v2.8.0.dev2`, and so on. The development suffix belongs to the Git tag/release metadata and must not be written into `package.json`.

Release validation must reject a tag whose base version does not match `package.json` and must not mutate the source version.

## Development debug server

When the extension is running in debug mode (`VSCODE_DEBUG_MODE=true`), a development HTTP server starts on port 7331. It provides runtime inspection of extension state:

- `GET /state` — major subsystem state
- `GET /debugger` — debugger state
- `GET /debugger/scene-tree` — parsed scene tree
- `GET /debugger/inspector` — inspector state
- `POST /eval` — evaluate development-only code in extension context
- `POST /reload` — reload the VS Code window

This server is a development-only tool, gated behind the debug flag and excluded from linting. See `src/dev/debug_server.ts`.
