# Neo-Godot-Tools

> A local-first GDScript language and debugging toolchain for Visual Studio Code.

Neo-Godot-Tools is a focused evolution of the Godot VS Code tooling architecture. Its current development priority is **fast, incremental, local semantic intelligence**, with Godot's native Language Server retained as an explicit fallback for engine-native, dynamic, ambiguous, or unsupported semantics.

## Navigation

- [Overview](#overview)
- [Language Intelligence](#language-intelligence)
- [Local-First Architecture](#local-first-architecture)
- [Godot Documentation Navigation](#godot-documentation-navigation)
- [Debugger](#debugger)
- [Commands](#commands)
- [Configuration](#configuration)
- [Performance](#performance)
- [Development](#development)
- [Documentation](#documentation)
- [Contributing](#contributing)

## Overview

Neo-Godot-Tools provides VS Code integration for Godot projects, including:

- GDScript syntax support;
- local semantic analysis and incremental indexing;
- completion, hover, definition, references, rename, and signature help;
- Godot built-in class and member documentation navigation;
- `res://` resource navigation and previews;
- GDScript formatting;
- diagnostics and language-server integration;
- Godot debugging and scene inspection;
- GDResource (`.tscn` / `.tres`) support;
- GDShader syntax support;
- scene/script switching and scene preview.

The project supports both Godot 3-style and Godot 4-style GDScript syntax through compatibility fixtures and conservative semantic analysis.

## Language Intelligence

The extension is intentionally **local-first**.

```text
VS Code
   │
   ▼
LanguageService
   │
   ▼
Semantic Query Engine
   │
   ├── Symbol / Binding / Reference Indexes
   ├── Type Resolution
   ├── Dependency Graph
   └── Incremental File Index
            │
            ▼
       GDScript Analyzer
            │
            └──── unresolved / dynamic / engine-native ────► Godot LSP
```

Common project-level operations should not require a round trip through Godot LSP. This reduces latency and prevents the language server from becoming the bottleneck during ordinary editing.

### Confidence-aware fallback

The analyzer does not guess when its model is incomplete:

| Local result | Action |
| --- | --- |
| Exact | Return local result |
| Safe inferred | Return local result |
| Partial / ambiguous | Use fallback when available |
| Unknown / unsupported | Use Godot LSP |

This policy is especially important for dynamic GDScript, where an incorrect definition or completion is worse than a slightly slower fallback.

## Godot Documentation Navigation

Ctrl+Click navigation covers both project symbols and Godot's native API.

Examples include:

```gdscript
var node: Node
node.add_child(child)
Vector2.ZERO
Vector2.length()
Node.PROCESS_MODE_INHERIT
```

The intended routing is:

```text
Project symbol
    → local semantic definition

Godot native class
    → Godot documentation

Godot native method/property/constant
    → class documentation + member anchor

Local model cannot resolve safely
    → bounded Godot LSP fallback
```

The documentation viewer uses the extension's `.gddoc` custom editor rather than opening an unrelated external page. Native symbol resolution is bounded and cancellation-aware so Ctrl+Click cannot create an unbounded pending request.

## Debugger

The GDScript debugger provides:

- current-file and pinned-file debugging;
- breakpoints;
- exception handling;
- step in / step over / step out;
- variable inspection;
- call stack;
- active scene tree;
- remote node inspection;
- inspector value editing;
- scene preview integration.

Minimal `launch.json` configuration:

```json
{
  "name": "Launch",
  "type": "godot",
  "request": "launch"
}
```

## Commands

Commands are available from the VS Code Command Palette under **Godot Tools**.

Important commands include:

- Open workspace with Godot editor
- Open EditorSettings file
- Start / stop the GDScript Language Server
- List Godot classes
- Debug current file
- Debug pinned file
- Pin / unpin scene file
- Open pinned scene
- Refresh scene preview
- Open current scene or main script
- Go to Definition
- Open Documentation
- Copy node/resource paths
- Switch between scene and script

## Configuration

### Godot executable

- `godotTools.editorPath.godot3` — Godot 3 editor executable.
- `godotTools.editorPath.godot4` — Godot 4 editor executable.

### Documentation viewer

- `godotTools.documentation.pageScale` — documentation scale, 50–200%.
- `godotTools.documentation.displayMinimap` — documentation minimap visibility.

### Language Server

- `godotTools.lsp.serverHost`
- `godotTools.lsp.serverPort`
- `godotTools.lsp.headless`

The LSP settings configure the explicit fallback/engine-semantic channel. They do not replace the local semantic engine.

### Formatter

- `godotTools.formatter.maxEmptyLines`
- `godotTools.formatter.denseFunctionParameters`
- `godotTools.formatter.spacesBeforeEndOfLineComment`

## Performance

The semantic system is designed around incremental work rather than workspace-wide recomputation.

Current performance work includes:

- source and API fingerprints;
- incremental file snapshots;
- targeted dependency invalidation;
- semantic query caching;
- cancellation-aware interactive requests;
- stale update protection;
- LSP request instrumentation;
- synthetic and real-project benchmark runners.

Target interactive budgets are:

| Operation | Target |
| --- | ---: |
| Completion | < 30 ms |
| Hover | < 20 ms |
| Definition | < 25 ms |
| LSP fallback | < 300 ms |

Large-project evidence is measured separately for 100, 500, 1K, and 5K-file workloads. Persistent caches and worker threads remain evidence-driven decisions rather than default architecture.

## Development

Install dependencies and compile:

```bash
npm ci
npm run compile
```

Useful checks:

```bash
npm run lint
npm test
npm run test:engine
```

The project uses TypeScript for extension code and keeps semantic logic independent from VS Code presentation types wherever possible.

## Documentation

Architecture and development documents:

- [`docs/development-roadmap.md`](docs/development-roadmap.md) — current roadmap and implementation gates.
- [`docs/semantic-architecture.md`](docs/semantic-architecture.md) — local semantic model and query engine.
- [`docs/lsp-architecture.md`](docs/lsp-architecture.md) — local-first/LSP boundary and lifecycle.
- [`docs/semantic-benchmarking.md`](docs/semantic-benchmarking.md) — benchmark methodology and real-project measurements.
- [`docs/performance-profiling.md`](docs/performance-profiling.md) — runtime profiling.
- [`docs/lsp-call-audit.md`](docs/lsp-call-audit.md) — LSP call inventory and routing audit.
- [`docs/roadmap-batch-2026-09-12.md`](docs/roadmap-batch-2026-09-12.md) — latest implementation batch.

The roadmap is the source of truth for implementation status. Individual documents describe the architecture and evidence behind those status decisions.

## Contributing

Contributions should preserve the local-first architecture:

1. prefer fixing semantic coverage in the analyzer/index/query layer;
2. keep providers thin and presentation-oriented;
3. use Godot LSP explicitly as fallback rather than registering competing automatic providers;
4. keep fallback requests bounded and cancellable;
5. add regression fixtures for compatibility failures;
6. add measurements before introducing persistent caches, workers, or broad architectural complexity.

See [`CONTRIBUTING.md`](CONTRIBUTING.md) for repository contribution guidelines.

## License

MIT
